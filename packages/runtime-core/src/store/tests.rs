use super::*;
use crate::canonical_digest::{STEP, STEP_RECORD};
use crate::provider::state::flock;
use crate::test_root::private_test_root;
use serde::Serialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt, symlink};
use std::sync::Barrier;
use std::time::{Duration, Instant, UNIX_EPOCH};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self(private_test_root(
            &fs::canonicalize(std::env::temp_dir()).unwrap(),
            "hack-step-store",
        ))
    }

    fn base(&self) -> PathBuf {
        self.0.join("store")
    }

    fn root(&self) -> PathBuf {
        self.base().join(disk::FORMAT_DIRECTORY)
    }

    fn open(&self) -> Store {
        Store::open(&self.base()).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn mode(path: &Path) -> u32 {
    fs::symlink_metadata(path).unwrap().permissions().mode() & 0o7777
}

#[test]
fn format_directory_and_version_file_use_the_same_number() {
    let directory_number = disk::FORMAT_DIRECTORY.strip_prefix("hack.store-").unwrap();
    let version_number = std::str::from_utf8(disk::VERSION)
        .unwrap()
        .strip_prefix("hack.store/")
        .unwrap()
        .strip_suffix('\n')
        .unwrap();
    assert_eq!(directory_number, version_number);
}

#[test]
fn open_creates_private_layout_and_holds_shared_lock_until_drop() {
    let fixture = Fixture::new();
    let first = fixture.open();
    let second = fixture.open();
    assert_eq!(mode(&fixture.base()), 0o700);
    assert_eq!(mode(&fixture.root()), 0o700);
    for name in ["records", "cas", "files", "tags", "tmp"] {
        let path = fixture.root().join(name);
        assert!(path.is_dir());
        assert_eq!(mode(&path), 0o700);
    }
    for name in ["key", "lock", "VERSION"] {
        let path = fixture.root().join(name);
        assert!(path.is_file());
        assert_eq!(mode(&path), 0o600);
    }
    assert_eq!(fs::metadata(fixture.root().join("key")).unwrap().len(), 32);
    assert_eq!(
        fs::read(fixture.root().join("VERSION")).unwrap(),
        b"hack.store/1\n"
    );
    let lock = File::open(fixture.root().join("lock")).unwrap();
    drop(first);
    assert_eq!(
        flock(&lock, libc::LOCK_EX | libc::LOCK_NB)
            .unwrap_err()
            .kind(),
        io::ErrorKind::WouldBlock
    );
    drop(second);
    // Another test in this binary may be spawning a child process: until that child
    // execs, it holds copies of every open descriptor, so the last shared lock can be
    // released a moment late. It is never released early, so wait for it, briefly.
    let deadline = Instant::now() + Duration::from_secs(2);
    while flock(&lock, libc::LOCK_EX | libc::LOCK_NB).is_err() {
        assert!(
            Instant::now() < deadline,
            "the shared lock outlived both handles"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Eight threads open a fresh store at once. The test has its own time limit, so a
/// lock protocol that never finishes fails here instead of hanging the suite.
#[test]
fn concurrent_first_opens_share_one_generation_and_key() {
    let fixture = Fixture::new();
    let base = fixture.base();
    let start = std::sync::Arc::new(Barrier::new(8));
    let (sender, results) = std::sync::mpsc::channel();
    for _ in 0..8 {
        let (base, start, sender) = (base.clone(), start.clone(), sender.clone());
        std::thread::spawn(move || {
            start.wait();
            let store = Store::open(&base);
            let digest = store
                .as_ref()
                .map(|store| store.keyed_digest(STEP, &json!(42)).unwrap());
            // Keep every handle (and its shared lock) until all openers are done.
            let _ = sender.send((digest.map_err(|error| format!("{error:?}")), store.ok()));
        });
    }
    drop(sender);
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut digests = Vec::new();
    let mut held = Vec::new();
    for _ in 0..8 {
        let left = deadline.saturating_duration_since(Instant::now());
        let (digest, store) = results
            .recv_timeout(left)
            .expect("an opener did not return within 15 s");
        digests.push(digest.expect("an opener failed"));
        held.push(store);
    }
    assert!(digests.iter().all(|digest| *digest == digests[0]));
}

/// A store whose lock another descriptor holds exclusively makes `open` fail with
/// `step_store_busy` at its deadline, never wait without bound.
#[test]
fn an_open_behind_a_held_lock_fails_busy_at_its_deadline() {
    let fixture = Fixture::new();
    drop(fixture.open());
    let holder = File::open(fixture.root().join("lock")).unwrap();
    flock(&holder, libc::LOCK_EX).unwrap();
    let started = Instant::now();
    let error = match disk::open_until(&fixture.base(), started + Duration::from_millis(300)) {
        Ok(_) => panic!("open succeeded behind an exclusive lock"),
        Err(error) => error,
    };
    let elapsed = started.elapsed();
    assert!(
        format!("{error:?}").contains("step_store_busy"),
        "{error:?}"
    );
    assert!(elapsed >= Duration::from_millis(300), "{elapsed:?}");
    assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
    drop(holder);
    assert!(fixture.open().keyed_digest(STEP, &json!(1)).is_ok());
}

/// Initialization that holds the exclusive lock for 400 ms does not make a waiting
/// opener report busy: its time deadline decides, not a count of tries (a 32-try
/// loop 5 ms apart gave up after about 160 ms).
#[test]
fn a_slow_initialization_is_waited_for_until_the_time_deadline() {
    let fixture = Fixture::new();
    let root = fixture.root();
    // The state an initializer is in: the directory and lock exist, nothing else.
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&root)
        .unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(root.join("lock"))
        .unwrap();
    flock(&lock, libc::LOCK_EX).unwrap();
    // The release thread can start running before spawn returns.
    let started = Instant::now();
    let releaser = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        drop(lock);
    });
    let store = disk::open_until(&fixture.base(), started + Duration::from_secs(3));
    let elapsed = started.elapsed();
    releaser.join().unwrap();
    assert!(store.is_ok(), "{:?}", store.err());
    assert!(elapsed >= Duration::from_millis(400), "{elapsed:?}");
    assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
}

/// Run as a separate process by the multi-process store tests
/// (ignored in a normal run). Opens the store named by the environment, prints its
/// key's digest of a fixed value, and keeps the store open for the requested time.
#[test]
#[ignore = "run as a child process by the multi-process store test"]
fn child_store_opener() {
    let Ok(root) = std::env::var("HACK_STORE_TEST_ROOT") else {
        return;
    };
    let hold: u64 = std::env::var("HACK_STORE_TEST_HOLD_MS")
        .unwrap()
        .parse()
        .unwrap();
    let store = Store::open(Path::new(&root)).unwrap();
    println!(
        "\nSTORE-DIGEST {}",
        store.keyed_digest(STEP, &json!(42)).unwrap()
    );
    std::thread::sleep(Duration::from_millis(hold));
    drop(store);
}

/// Threads and processes behave differently for these locks, so the first open is
/// also tested across processes. Every child must finish within the time limit.
fn processes_open_the_same_store(holds_ms: &[u64], holder_first: bool) {
    let fixture = Fixture::new();
    let exe = std::env::current_exe().unwrap();
    let spawn = |hold_ms: u64| {
        std::process::Command::new(&exe)
            .args([
                "--exact",
                "store::tests::child_store_opener",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("HACK_STORE_TEST_ROOT", fixture.base())
            .env("HACK_STORE_TEST_HOLD_MS", hold_ms.to_string())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap()
    };
    let mut children = Vec::new();
    for (index, hold) in holds_ms.iter().enumerate() {
        children.push(spawn(*hold));
        if holder_first && index == 0 {
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut digests = Vec::new();
    for mut child in children {
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("a store opener process did not finish within 20 s");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let mut output = String::new();
        std::io::Read::read_to_string(&mut child.stdout.take().unwrap(), &mut output).unwrap();
        assert!(status.success(), "opener failed: {output}");
        let digest = output
            .lines()
            .find_map(|line| line.split("STORE-DIGEST ").nth(1))
            .unwrap_or_else(|| panic!("no digest in: {output}"))
            .to_owned();
        digests.push(digest);
    }
    assert_eq!(digests.len(), holds_ms.len());
    assert!(digests.iter().all(|digest| *digest == digests[0]));
}

/// A long-lived holder keeps its shared lock while six other processes open.
#[test]
fn separate_processes_open_alongside_a_long_lived_holder() {
    processes_open_the_same_store(&[3_000, 0, 0, 0, 0, 0, 0], true);
}

/// Seven processes race to open a fresh store, and every one keeps its handle for
/// 1.5 s: the first-open race that stranded blocked openers on macOS.
#[test]
fn separate_processes_race_to_open_a_fresh_store_and_keep_it() {
    processes_open_the_same_store(&[1_500; 7], false);
}

#[test]
fn reopening_reuses_key_and_other_stores_use_distinct_keys() {
    let fixture = Fixture::new();
    let other = Fixture::new();
    let value = json!({"number": 9, "label": "fixture"});
    let first = fixture.open();
    let expected = first.keyed_digest(STEP, &value).unwrap();
    assert_eq!(first.keyed_digest(STEP, &value).unwrap(), expected);
    assert_ne!(first.keyed_digest(STEP_RECORD, &value).unwrap(), expected);
    drop(first);
    assert_eq!(fixture.open().keyed_digest(STEP, &value).unwrap(), expected);
    assert_ne!(other.open().keyed_digest(STEP, &value).unwrap(), expected);
}

#[test]
fn incompatible_version_sets_aside_entire_store_and_starts_fresh() {
    let fixture = Fixture::new();
    drop(fixture.open());
    let previous_archive = set_aside_at(&fixture, disk::unix_millis().unwrap() - 1000);
    let old = fixture.open();
    assert!(previous_archive.is_dir());
    let key = example_key(StepClass::Slot);
    old.record(&key, output(None), "run-1").unwrap();
    let old_digest = old.keyed_digest(STEP, &json!(42)).unwrap();
    drop(old);
    fs::write(fixture.root().join("VERSION"), b"hack.store/2\n").unwrap();
    let fresh = fixture.open();
    assert!(!previous_archive.exists());
    assert_ne!(fresh.keyed_digest(STEP, &json!(42)).unwrap(), old_digest);
    assert_eq!(
        fs::read(fixture.root().join("VERSION")).unwrap(),
        b"hack.store/1\n"
    );
    assert_eq!(
        fresh.lookup(&key, |_| panic!("unexpected observation")),
        Lookup::Miss(MissReason::NoRecord)
    );
    let archive = fs::read_dir(fixture.base())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("hack.store-1.old-")
        })
        .unwrap();
    let millis = archive
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .rsplit_once('-')
        .unwrap()
        .1;
    let marker = archive.join("SET_ASIDE");
    assert!(fs::symlink_metadata(&marker).unwrap().is_file());
    assert_eq!(mode(&marker), 0o600);
    assert_eq!(
        fs::read(&marker).unwrap(),
        archive_marker(&fixture.base(), millis)
    );
    assert_eq!(
        fs::read(archive.join("VERSION")).unwrap(),
        b"hack.store/2\n"
    );
    assert!(
        archive
            .join(
                record_path(&fixture.root(), &key)
                    .strip_prefix(fixture.root())
                    .unwrap()
            )
            .is_file()
    );
}

#[test]
fn a_damaged_version_or_key_cannot_rotate_a_store_with_a_live_handle() {
    for name in ["VERSION", "key"] {
        let fixture = Fixture::new();
        let live = fixture.open();
        let value = json!(42);
        let digest = live.keyed_digest(STEP, &value).unwrap();
        let key = example_key(StepClass::Slot);
        let record = live.record(&key, output(None), "run-1").unwrap();
        let root = fixture.root();
        let before = fs::metadata(&root).unwrap();
        let damaged = root.join(name);
        fs::write(&damaged, b"damaged").unwrap();

        let deadline = Instant::now() + Duration::from_millis(100);
        let Err(error) = disk::open_until(&fixture.base(), deadline) else {
            panic!("open succeeded with a damaged {name} and a live handle");
        };
        assert_eq!(error.code, "step_store_busy", "{name}");
        let after = fs::metadata(&root).unwrap();
        assert_eq!((after.dev(), after.ino()), (before.dev(), before.ino()));
        assert_eq!(fs::read(damaged).unwrap(), b"damaged");
        let entries: Vec<_> = fs::read_dir(fixture.base())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(entries, [root]);
        assert_eq!(live.keyed_digest(STEP, &value).unwrap(), digest);
        assert_eq!(live.lookup(&key, |_| true), Lookup::Hit(record));
    }
}

#[test]
fn other_format_directories_are_left_in_place() {
    let fixture = Fixture::new();
    let future = fixture.base().join("hack.store-2");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&future)
        .unwrap();
    fs::write(future.join("VERSION"), b"hack.store/2\n").unwrap();
    let expected = fixture.open().keyed_digest(STEP, &json!(42)).unwrap();
    assert_eq!(fs::read(future.join("VERSION")).unwrap(), b"hack.store/2\n");
    assert_eq!(
        fixture.open().keyed_digest(STEP, &json!(42)).unwrap(),
        expected
    );
}

/// A damaged key in a store that has VERSION sets the whole store aside: keyed
/// digests made with the lost key can never be reproduced, so its records are
/// useless, and a cache rebuilds rather than refusing every later open.
#[test]
fn a_damaged_key_in_a_versioned_store_sets_the_store_aside() {
    type Damage = fn(&Path, &Path);
    let cases: [(&str, Damage); 6] = [
        ("missing", |key, _| fs::remove_file(key).unwrap()),
        ("empty", |key, _| fs::write(key, []).unwrap()),
        ("31 bytes", |key, _| fs::write(key, [0; 31]).unwrap()),
        ("33 bytes", |key, _| fs::write(key, [0; 33]).unwrap()),
        ("symlink", |key, other| {
            fs::remove_file(key).unwrap();
            symlink(other, key).unwrap();
        }),
        ("directory", |key, _| {
            fs::remove_file(key).unwrap();
            fs::create_dir(key).unwrap();
        }),
    ];
    for (name, damage) in cases {
        let fixture = Fixture::new();
        let other = Fixture::new();
        drop(other.open());
        let original = {
            let store = fixture.open();
            store.keyed_digest(STEP, &json!("x")).unwrap()
        };
        let key = fixture.root().join("key");
        damage(&key, &other.root().join("key"));
        let store = Store::open(&fixture.base()).unwrap_or_else(|_| panic!("{name}: open"));
        assert_eq!(fs::metadata(&key).unwrap().len(), 32, "{name}");
        assert_eq!(mode(&key), 0o600, "{name}");
        assert_ne!(
            store.keyed_digest(STEP, &json!("x")).unwrap(),
            original,
            "{name}"
        );
        let archived: Vec<_> = fs::read_dir(fixture.base())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|entry| entry.starts_with("hack.store-1.old-"))
            .collect();
        assert_eq!(archived.len(), 1, "{name}: {archived:?}");
    }
}

#[test]
fn a_key_with_the_wrong_mode_is_repaired_without_losing_records() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let expected = store.keyed_digest(STEP, &json!(42)).unwrap();
    let key = example_key(StepClass::Slot);
    let record = store.record(&key, output(None), "run-1").unwrap();
    drop(store);

    let key_file = fixture.root().join("key");
    for old_mode in [0o644, 0o000] {
        fs::set_permissions(&key_file, fs::Permissions::from_mode(old_mode)).unwrap();
        let store = fixture.open();
        assert_eq!(mode(&key_file), 0o600);
        assert_eq!(store.keyed_digest(STEP, &json!(42)).unwrap(), expected);
        assert_eq!(store.lookup(&key, |_| true), Lookup::Hit(record.clone()));
    }
    assert_eq!(fs::read_dir(fixture.base()).unwrap().count(), 1);
}

#[test]
fn a_transient_key_read_error_leaves_the_store_available_for_retry() {
    let fixture = Fixture::new();
    let expected = fixture.open().keyed_digest(STEP, &json!(42)).unwrap();
    disk::FAIL_KEY_READ.set(true);
    let result = Store::open(&fixture.base());
    disk::FAIL_KEY_READ.set(false);
    let Err(error) = result else {
        panic!("the key read should fail");
    };
    assert_eq!(error.code, "step_store_unavailable");
    assert_eq!(fs::read_dir(fixture.base()).unwrap().count(), 1);
    assert_eq!(
        fixture.open().keyed_digest(STEP, &json!(42)).unwrap(),
        expected
    );
}

#[test]
fn a_hard_linked_key_is_refused_without_repair_or_set_aside() {
    let fixture = Fixture::new();
    drop(fixture.open());
    let key = fixture.root().join("key");
    let other_name = fixture.0.join("other-key");
    fs::hard_link(&key, &other_name).unwrap();
    fs::set_permissions(&key, fs::Permissions::from_mode(0o644)).unwrap();
    assert_open_refused(&fixture.base());
    assert_eq!(mode(&other_name), 0o644);
    assert_eq!(fs::read_dir(fixture.base()).unwrap().count(), 1);
    assert!(key.is_file());
}

#[test]
fn an_existing_key_is_synced_again_before_publishing_a_missing_version() {
    let fixture = Fixture::new();
    let expected = fixture.open().keyed_digest(STEP, &json!(42)).unwrap();
    let version = fixture.root().join("VERSION");
    fs::remove_file(&version).unwrap();
    disk::FAIL_KEY_DIR_SYNC.set(true);
    let result = Store::open(&fixture.base());
    disk::FAIL_KEY_DIR_SYNC.set(false);
    let Err(error) = result else {
        panic!("the key directory sync should fail");
    };
    assert_eq!(error.code, "step_store_unavailable");
    assert!(!version.exists());
    assert_eq!(
        fixture.open().keyed_digest(STEP, &json!(42)).unwrap(),
        expected
    );
    assert_eq!(fs::read(version).unwrap(), b"hack.store/1\n");
}

fn archive_path(fixture: &Fixture, time: u64) -> PathBuf {
    fixture.base().join(format!("hack.store-1.old-{time}"))
}

fn archive_marker(base: &Path, millis: &str) -> Vec<u8> {
    format!(
        "hack.store-set-aside/1\nbase={}\nat={millis}\n",
        base.display()
    )
    .into_bytes()
}

fn make_archive(fixture: &Fixture, time: u64) -> PathBuf {
    let path = archive_path(fixture, time);
    fs::create_dir(&path).unwrap();
    fs::write(
        path.join("SET_ASIDE"),
        archive_marker(&fixture.base(), &time.to_string()),
    )
    .unwrap();
    File::create(path.join("lock")).unwrap();
    path
}

fn set_aside_at(fixture: &Fixture, time: u64) -> PathBuf {
    let lock = File::open(fixture.root().join("lock")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while let Err(error) = flock(&lock, libc::LOCK_EX | libc::LOCK_NB) {
        // A child spawned by another test can briefly inherit the old shared lock.
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        assert!(Instant::now() < deadline, "shared lock outlived its handle");
        std::thread::sleep(Duration::from_millis(5));
    }
    disk::set_aside(&fixture.base(), &fixture.root(), time).unwrap();
    archive_path(fixture, time)
}

#[test]
fn open_keeps_only_the_newest_marked_archive_and_preserves_other_entries() {
    let fixture = Fixture::new();
    fs::DirBuilder::new()
        .mode(0o700)
        .create(fixture.base())
        .unwrap();
    let now = disk::unix_millis().unwrap();
    let older = make_archive(&fixture, now - 2);
    let newest = make_archive(&fixture, now - 1);
    let file = archive_path(&fixture, now);
    let alias = archive_path(&fixture, now + 1);
    let outside = fixture.0.join("outside");
    let invalid_name = fixture.base().join("hack.store-1.old-1-extra");
    let other_format = fixture.base().join("hack.store-2.old-1");
    for directory in [&outside, &invalid_name, &other_format] {
        fs::create_dir(directory).unwrap();
    }
    let sentinel = outside.join("sentinel");
    fs::write(&sentinel, b"fixture").unwrap();
    fs::write(&file, b"fixture").unwrap();
    symlink(&outside, &alias).unwrap();
    symlink(&outside, older.join("outside")).unwrap();

    drop(fixture.open());
    assert!(!older.exists());
    assert!(newest.is_dir());
    assert!(invalid_name.is_dir());
    assert!(other_format.is_dir());
    assert!(file.is_file());
    assert!(fs::symlink_metadata(alias).unwrap().is_symlink());
    assert_eq!(fs::read(sentinel).unwrap(), b"fixture");
}

#[test]
fn open_removes_even_the_newest_archive_after_seven_days() {
    let fixture = Fixture::new();
    drop(fixture.open());
    let eight_days = Duration::from_secs(8 * 24 * 60 * 60);
    let then = disk::unix_millis().unwrap() - u64::try_from(eight_days.as_millis()).unwrap();
    let archive = set_aside_at(&fixture, then);
    let uid = fs::metadata(&archive).unwrap().uid();
    disk::cleanup_archives(&fixture.base(), uid ^ 1);
    assert!(archive.is_dir());
    drop(fixture.open());
    assert!(!archive.exists());
}

#[test]
fn opening_a_healthy_store_removes_old_archives_and_keeps_the_newest_young_one() {
    let fixture = Fixture::new();
    let live = fixture.open();
    let expected = live.keyed_digest(STEP, &json!(42)).unwrap();
    let now = disk::unix_millis().unwrap();
    let old = make_archive(&fixture, now - 8 * 24 * 60 * 60 * 1_000);
    let young = make_archive(&fixture, now - 1_000);

    let reopened = fixture.open();
    assert_eq!(reopened.keyed_digest(STEP, &json!(42)).unwrap(), expected);
    assert!(!old.exists());
    assert!(young.is_dir());
}

#[test]
fn a_live_store_at_an_archive_pattern_path_survives_a_healthy_reopen() {
    let fixture = Fixture::new();
    let _live = fixture.open();
    let then = disk::unix_millis().unwrap() - 8 * 24 * 60 * 60 * 1_000;
    let other_base = archive_path(&fixture, then);
    let other = Store::open(&other_base).unwrap();
    let key = example_key(StepClass::Slot);
    let record = other.record(&key, output(None), "run-1").unwrap();

    drop(fixture.open());
    assert!(other_base.is_dir());
    assert_eq!(
        Store::open(&other_base).unwrap().lookup(&key, |_| true),
        Lookup::Hit(record)
    );
}

#[test]
fn archive_cleanup_leaves_unverified_or_busy_archives_in_place() {
    let fixture = Fixture::new();
    let _live = fixture.open();
    let then = disk::unix_millis().unwrap() - 8 * 24 * 60 * 60 * 1_000;
    let wrong_base = make_archive(&fixture, then);
    fs::write(
        wrong_base.join("SET_ASIDE"),
        archive_marker(&fixture.0, &then.to_string()),
    )
    .unwrap();
    let wrong_time = make_archive(&fixture, then + 1);
    fs::write(
        wrong_time.join("SET_ASIDE"),
        archive_marker(&fixture.base(), &then.to_string()),
    )
    .unwrap();
    let missing_lock = make_archive(&fixture, then + 2);
    fs::remove_file(missing_lock.join("lock")).unwrap();
    let busy = make_archive(&fixture, then + 3);
    let lock = File::open(busy.join("lock")).unwrap();
    flock(&lock, libc::LOCK_SH | libc::LOCK_NB).unwrap();
    let linked_marker = make_archive(&fixture, then + 4);
    let marker = fixture.0.join("marker");
    fs::rename(linked_marker.join("SET_ASIDE"), &marker).unwrap();
    symlink(marker, linked_marker.join("SET_ASIDE")).unwrap();
    let linked_lock = make_archive(&fixture, then + 5);
    fs::remove_file(linked_lock.join("lock")).unwrap();
    symlink(fixture.root().join("lock"), linked_lock.join("lock")).unwrap();

    drop(fixture.open());
    for path in [
        &wrong_base,
        &wrong_time,
        &missing_lock,
        &busy,
        &linked_marker,
        &linked_lock,
    ] {
        assert!(path.is_dir(), "removed {path:?}");
    }
    drop(lock);
    drop(fixture.open());
    assert!(!busy.exists());
}

#[test]
fn reopening_clears_a_marker_left_before_the_archive_rename() {
    for needs_initialization in [false, true] {
        let fixture = Fixture::new();
        let live = fixture.open();
        let expected = live.keyed_digest(STEP, &json!(42)).unwrap();
        let before = fs::metadata(fixture.root()).unwrap();
        drop(live);
        let marker = fixture.root().join("SET_ASIDE");
        let millis = disk::unix_millis().unwrap().to_string();
        disk::publish(
            &fixture.root(),
            &marker,
            &archive_marker(&fixture.base(), &millis),
        )
        .unwrap();
        if needs_initialization {
            fs::remove_file(fixture.root().join("VERSION")).unwrap();
        }

        let reopened = fixture.open();
        assert!(!marker.exists());
        assert_eq!(fs::metadata(fixture.root()).unwrap().ino(), before.ino());
        assert_eq!(reopened.keyed_digest(STEP, &json!(42)).unwrap(), expected);
        assert_eq!(fs::read_dir(fixture.base()).unwrap().count(), 1);
    }
}

#[test]
fn cleanup_runs_outside_the_live_stores_exclusive_lock() {
    let fixture = Fixture::new();
    disk::CHECK_CLEANUP_LOCK.set(true);
    let result = Store::open(&fixture.base());
    disk::CHECK_CLEANUP_LOCK.set(false);
    drop(result.unwrap());
}

fn write_legacy_markers(path: &Path) {
    fs::write(path.join("VERSION"), b"hack.store/1\n").unwrap();
    File::create(path.join("lock")).unwrap();
}

#[test]
fn open_removes_the_legacy_flat_layout_and_its_sibling_archives() {
    let fixture = Fixture::new();
    let live = fixture.open();
    let key = example_key(StepClass::Slot);
    let record = live.record(&key, output(None), "run-1").unwrap();
    let base = fixture.base();
    write_legacy_markers(&base);
    fs::write(base.join("key"), b"legacy").unwrap();
    for name in ["records", "cas", "files", "tags", "tmp"] {
        fs::create_dir(base.join(name)).unwrap();
        fs::write(base.join(name).join("legacy"), b"legacy").unwrap();
    }
    let archive = fixture.0.join("store.old-123");
    let colocated = base.join("store.old-123");
    let unrelated = fixture.0.join("store.old-123-extra");
    let empty_suffix = fixture.0.join("store.old-");
    for directory in [&archive, &colocated, &unrelated, &empty_suffix] {
        fs::create_dir(directory).unwrap();
    }
    write_legacy_markers(&archive);

    let reopened = fixture.open();
    let mut entries: Vec<_> = fs::read_dir(&base)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    entries.sort();
    assert_eq!(entries, [fixture.root(), colocated]);
    assert!(!archive.exists());
    assert!(unrelated.is_dir());
    assert!(empty_suffix.is_dir());
    assert_eq!(reopened.lookup(&key, |_| true), Lookup::Hit(record));

    // A P1 rotation leaves an archive even when no flat store remains: it is
    // removed when its VERSION holds the P1 format, and a directory that only has
    // the name (no P1 VERSION inside) is left alone.
    fs::create_dir(&archive).unwrap();
    write_legacy_markers(&archive);
    drop(fixture.open());
    assert!(!archive.exists());
    fs::create_dir(&archive).unwrap();
    drop(fixture.open());
    assert!(archive.is_dir());
}

#[test]
fn legacy_cleanup_leaves_the_flat_layout_untouched_while_its_lock_is_held() {
    let fixture = Fixture::new();
    let _live = fixture.open();
    let base = fixture.base();
    write_legacy_markers(&base);
    fs::write(base.join("key"), b"legacy").unwrap();
    let records = base.join("records");
    fs::create_dir(&records).unwrap();
    fs::write(records.join("entry"), b"legacy").unwrap();
    let lock = File::open(base.join("lock")).unwrap();
    flock(&lock, libc::LOCK_SH | libc::LOCK_NB).unwrap();

    drop(fixture.open());
    assert_eq!(fs::read(base.join("VERSION")).unwrap(), disk::VERSION);
    assert_eq!(
        fs::metadata(base.join("lock")).unwrap().ino(),
        lock.metadata().unwrap().ino()
    );
    assert_eq!(fs::read(base.join("key")).unwrap(), b"legacy");
    assert_eq!(fs::read(records.join("entry")).unwrap(), b"legacy");
    drop(lock);
    drop(fixture.open());
    assert_eq!(fs::read_dir(&base).unwrap().count(), 1);
}

#[test]
fn legacy_cleanup_retries_after_a_flat_entry_cannot_be_removed() {
    let fixture = Fixture::new();
    let _live = fixture.open();
    let base = fixture.base();
    write_legacy_markers(&base);
    // remove_file cannot unlink a directory, regardless of the test user's privileges.
    let key = base.join("key");
    fs::create_dir(&key).unwrap();
    fs::create_dir(base.join("records")).unwrap();

    drop(fixture.open());
    assert!(key.is_dir());
    assert!(base.join("lock").is_file());
    assert_eq!(fs::read(base.join("VERSION")).unwrap(), disk::VERSION);
    assert!(!base.join("records").exists());

    fs::remove_dir(&key).unwrap();
    fs::write(&key, b"legacy").unwrap();
    drop(fixture.open());
    assert_eq!(fs::read_dir(&base).unwrap().count(), 1);
}

#[test]
fn legacy_cleanup_skips_sibling_archives_with_a_busy_or_missing_lock() {
    let fixture = Fixture::new();
    drop(fixture.open());
    let busy = fixture.0.join("store.old-1");
    let missing = fixture.0.join("store.old-2");
    for path in [&busy, &missing] {
        fs::create_dir(path).unwrap();
        write_legacy_markers(path);
    }
    fs::remove_file(missing.join("lock")).unwrap();
    let lock = File::open(busy.join("lock")).unwrap();
    flock(&lock, libc::LOCK_EX | libc::LOCK_NB).unwrap();

    drop(fixture.open());
    assert!(busy.is_dir());
    assert!(missing.is_dir());
    drop(lock);
    drop(fixture.open());
    assert!(!busy.exists());
    assert!(missing.is_dir());
}

#[test]
fn a_different_or_symlinked_legacy_version_leaves_flat_entries_in_place() {
    let fixture = Fixture::new();
    drop(fixture.open());
    let base = fixture.base();
    let version = base.join("VERSION");
    let records = base.join("records");
    write_legacy_markers(&base);
    fs::create_dir(&records).unwrap();
    fs::write(base.join("key"), b"keep").unwrap();
    fs::write(&version, b"hack.store/1\nextra").unwrap();
    drop(fixture.open());
    assert_eq!(fs::read(&version).unwrap(), b"hack.store/1\nextra");

    fs::remove_file(&version).unwrap();
    symlink(fixture.root().join("VERSION"), &version).unwrap();
    drop(fixture.open());
    assert!(fs::symlink_metadata(version).unwrap().is_symlink());
    assert!(records.is_dir());
    assert_eq!(fs::read(base.join("key")).unwrap(), b"keep");
}

#[test]
fn legacy_cleanup_does_not_follow_symlinks() {
    let fixture = Fixture::new();
    let live = fixture.open();
    let value = json!(42);
    let expected = live.keyed_digest(STEP, &value).unwrap();
    let base = fixture.base();
    write_legacy_markers(&base);
    symlink(fixture.root().join("key"), base.join("key")).unwrap();
    let directory_link = base.join("records");
    symlink(fixture.root().join("records"), &directory_link).unwrap();
    let archive_link = fixture.0.join("store.old-123");
    symlink(fixture.root(), &archive_link).unwrap();

    let reopened = fixture.open();
    // The symlinked `records` cannot be removed, so the flat key, VERSION and lock
    // all stay together; nothing is followed, and the live key is untouched.
    assert!(fs::symlink_metadata(base.join("key")).unwrap().is_symlink());
    assert!(fixture.root().join("key").is_file());
    assert!(fs::symlink_metadata(directory_link).unwrap().is_symlink());
    assert!(fs::symlink_metadata(archive_link).unwrap().is_symlink());
    assert_eq!(fs::read(base.join("VERSION")).unwrap(), disk::VERSION);
    assert!(base.join("lock").is_file());
    assert_eq!(reopened.keyed_digest(STEP, &value).unwrap(), expected);
}

#[test]
fn legacy_cleanup_never_probes_version_through_a_sibling_symlink() {
    let fixture = Fixture::new();
    let target = fixture.0.join("legacy-target");
    fs::create_dir(&target).unwrap();
    write_legacy_markers(&target);
    let alias = fixture.0.join("store.old-123");
    symlink(&target, &alias).unwrap();

    let probes = disk::LEGACY_VERSION_PROBES.get();
    drop(fixture.open());
    assert_eq!(disk::LEGACY_VERSION_PROBES.get(), probes);
    assert!(fs::symlink_metadata(&alias).unwrap().is_symlink());
    assert_eq!(fs::read(target.join("VERSION")).unwrap(), disk::VERSION);

    fs::remove_file(&alias).unwrap();
    fs::rename(&target, &alias).unwrap();
    drop(fixture.open());
    assert_eq!(disk::LEGACY_VERSION_PROBES.get(), probes + 1);
    assert!(!alias.exists());
}

#[test]
fn legacy_cleanup_leaves_a_live_base_named_like_a_legacy_archive() {
    let fixture = Fixture::new();
    let base = fixture.0.join("store.old-123");
    let live = Store::open(&base).unwrap();
    assert_eq!(fs::read(live.root.join("VERSION")).unwrap(), disk::VERSION);
}

#[test]
fn aliased_ancestor_is_refused() {
    let fixture = Fixture::new();
    let real = fixture.0.join("real");
    fs::create_dir(&real).unwrap();
    let alias = fixture.0.join("alias");
    symlink(&real, &alias).unwrap();
    assert_open_refused(&alias.join("store"));
    assert!(!real.join("store").exists());
}

fn assert_open_refused(path: &Path) {
    let Err(error) = Store::open(path) else {
        panic!("unsafe store opened");
    };
    assert_eq!(error.code, "step_store_invalid");
}

fn input(byte: u8) -> InputDigest {
    InputDigest(Digest([byte; 32]))
}

fn inputs() -> BTreeMap<String, InputDigest> {
    BTreeMap::from([("first".into(), input(1)), ("second".into(), input(2))])
}

fn baseline_build() -> Build {
    Build::named("build-1").unwrap()
}

fn example_key(class: StepClass) -> StepKey {
    StepKey::new("example-step", 1, class, &inputs(), None, &baseline_build()).unwrap()
}

fn baseline_key() -> Digest {
    example_key(StepClass::Slot).digest()
}

#[test]
fn equal_inputs_produce_equal_keys() {
    let reordered = BTreeMap::from([("second".into(), input(2)), ("first".into(), input(1))]);
    let key = StepKey::new(
        "example-step",
        1,
        StepClass::Slot,
        &reordered,
        None,
        &baseline_build(),
    )
    .unwrap();
    assert_eq!(key.digest(), baseline_key());
}

#[test]
fn step_name_changes_key() {
    let key = StepKey::new(
        "other",
        1,
        StepClass::Slot,
        &inputs(),
        None,
        &baseline_build(),
    )
    .unwrap();
    assert_ne!(key.digest(), baseline_key());
}

#[test]
fn step_version_changes_key() {
    let key = StepKey::new(
        "example-step",
        2,
        StepClass::Slot,
        &inputs(),
        None,
        &baseline_build(),
    )
    .unwrap();
    assert_ne!(key.digest(), baseline_key());
}

#[test]
fn step_class_changes_key() {
    for class in [StepClass::Cas, StepClass::Boot, StepClass::FileIdentity] {
        assert_ne!(example_key(class).digest(), baseline_key());
    }
}

#[test]
fn any_input_name_changes_key() {
    for name in inputs().keys() {
        let mut renamed = inputs();
        let digest = renamed.remove(name).unwrap();
        renamed.insert("renamed".into(), digest);
        let key = StepKey::new(
            "example-step",
            1,
            StepClass::Slot,
            &renamed,
            None,
            &baseline_build(),
        )
        .unwrap();
        assert_ne!(key.digest(), baseline_key());
    }
}

#[test]
fn any_input_digest_changes_key() {
    for name in inputs().keys() {
        let mut changed = inputs();
        changed.insert(name.clone(), input(3));
        let key = StepKey::new(
            "example-step",
            1,
            StepClass::Slot,
            &changed,
            None,
            &baseline_build(),
        )
        .unwrap();
        assert_ne!(key.digest(), baseline_key());
    }
}

#[test]
fn epoch_changes_key() {
    let key = StepKey::new(
        "example-step",
        1,
        StepClass::Slot,
        &inputs(),
        Some("boot-1"),
        &baseline_build(),
    )
    .unwrap();
    let other = StepKey::new(
        "example-step",
        1,
        StepClass::Slot,
        &inputs(),
        Some("boot-2"),
        &baseline_build(),
    )
    .unwrap();
    assert_ne!(key.digest(), baseline_key());
    assert_ne!(other.digest(), key.digest());
}

#[test]
fn build_changes_key() {
    let key = StepKey::new(
        "example-step",
        1,
        StepClass::Slot,
        &inputs(),
        None,
        &Build::named("build-2").unwrap(),
    )
    .unwrap();
    assert_ne!(key.digest(), baseline_key());
}

#[test]
fn names_allow_only_lowercase_ascii_identifiers() {
    let class = StepClass::Slot;
    let too_long = "a".repeat(65);
    for name in [
        "", ".", "-a", "..", "../a", "a/b", "Upper", "a b", "a_b", "é", &too_long,
    ] {
        let step = StepKey::new(name, 1, class, &inputs(), None, &baseline_build()).unwrap_err();
        let input_name = BTreeMap::from([(name.into(), input(1))]);
        let input =
            StepKey::new("valid", 1, class, &input_name, None, &baseline_build()).unwrap_err();
        assert_eq!(step.code, "step_store_invalid");
        assert_eq!(input.code, "step_store_invalid");
    }
    let bound = format!("0{}", ".-a".repeat(21));
    let named = BTreeMap::from([(bound.clone(), input(1))]);
    assert!(StepKey::new(&bound, 1, class, &named, None, &baseline_build()).is_ok());
}

fn output(reference: Option<OutputRef>) -> Output {
    Output {
        digest: Digest([5; 32]),
        reference,
    }
}

fn record_path(root: &Path, key: &StepKey) -> PathBuf {
    let hex = format!("{:x}", crate::Hex(key.digest().0));
    root.join("records")
        .join(&key.step)
        .join(&hex[..2])
        .join(format!("{hex}.json"))
}

fn cas_path(root: &Path, digest: Digest) -> PathBuf {
    let hex = format!("{:x}", crate::Hex(digest.0));
    root.join("cas").join(&hex[..2]).join(&hex)
}

#[test]
fn record_round_trips_as_canonical_json() {
    let fixture = Fixture::new();
    let key = example_key(StepClass::FileIdentity);
    let store = fixture.open();
    let record = store.record(&key, output(None), "run-1").unwrap();
    assert!(record.observed_at > 0);

    let mut expected = json!({
        "v": 1,
        "step": "example-step",
        "stepVersion": 1,
        "class": "file-identity",
        "key": key.digest().to_string(),
        "inputs": {"first": input(1).0.to_string(), "second": input(2).0.to_string()},
        "epoch": null,
        "output": {"digest": record.output.digest.to_string(), "ref": null},
        "observedAt": record.observed_at,
        "producedBy": {"build": "build-1", "run": "run-1"},
    });
    expected["check"] = json!(
        canonical_digest::digest(STEP_RECORD, &expected)
            .unwrap()
            .to_string()
    );
    let bytes = fs::read(record_path(&fixture.root(), &key)).unwrap();
    assert_eq!(bytes, canonical_digest::canonical_json(&expected).unwrap());
    drop(store);

    let reopened = fixture.open();
    assert_eq!(
        reopened.lookup(&key, |found| found == &record),
        Lookup::Hit(record)
    );
}

#[test]
fn truncated_record_is_removed_as_torn() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let key = example_key(StepClass::Slot);
    store.record(&key, output(None), "run-1").unwrap();
    fs::write(record_path(&fixture.root(), &key), b"{").unwrap();
    assert_removed(&fixture, &store, &key, MissReason::TornRecord);
}

#[test]
fn record_with_a_flipped_check_is_removed_as_torn() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let key = example_key(StepClass::Slot);
    store.record(&key, output(None), "run-1").unwrap();
    edit_record(&fixture, &key, |value| {
        let mut check = value["check"].as_str().unwrap().as_bytes().to_vec();
        check[7] = if check[7] == b'a' { b'b' } else { b'a' };
        value["check"] = json!(String::from_utf8(check).unwrap());
    });
    assert_removed(&fixture, &store, &key, MissReason::TornRecord);
}

#[test]
fn record_at_a_wrong_key_or_step_path_is_removed_as_torn() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let key = example_key(StepClass::Slot);
    store.record(&key, output(None), "run-1").unwrap();
    let bytes = fs::read(record_path(&fixture.root(), &key)).unwrap();
    for (step, version) in [("example-step", 2), ("other", 1)] {
        let other = StepKey::new(
            step,
            version,
            StepClass::Slot,
            &inputs(),
            None,
            &baseline_build(),
        )
        .unwrap();
        let path = record_path(&fixture.root(), &other);
        disk::create_directory(path.parent().unwrap()).unwrap();
        fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_removed(&fixture, &store, &other, MissReason::TornRecord);
    }
}

#[test]
fn unfamiliar_record_version_is_removed_as_version_changed() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let key = example_key(StepClass::Slot);
    store.record(&key, output(None), "run-1").unwrap();
    edit_record(&fixture, &key, |value| value["v"] = json!(2));
    assert_removed(&fixture, &store, &key, MissReason::VersionChanged);
}

fn edit_record(fixture: &Fixture, key: &StepKey, edit: impl FnOnce(&mut Value)) {
    let path = record_path(&fixture.root(), key);
    let mut value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    edit(&mut value);
    fs::write(path, canonical_digest::canonical_json(&value).unwrap()).unwrap();
}

fn assert_removed(fixture: &Fixture, store: &Store, key: &StepKey, reason: MissReason) {
    let miss = store.lookup(key, |_| panic!("unexpected observation"));
    assert_eq!(miss, Lookup::Miss(reason));
    assert!(matches!(
        fs::symlink_metadata(record_path(&fixture.root(), key)),
        Err(error) if error.kind() == io::ErrorKind::NotFound
    ));
}

fn record_fixture() -> (Fixture, Store, StepKey, PathBuf) {
    let fixture = Fixture::new();
    let store = fixture.open();
    let key = example_key(StepClass::Slot);
    store.record(&key, output(None), "run-1").unwrap();
    let path = record_path(&fixture.root(), &key);
    (fixture, store, key, path)
}

#[test]
fn a_directory_at_the_record_path_is_torn_and_left_in_place() {
    let (_fixture, store, key, path) = record_fixture();
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert_eq!(
        store.lookup(&key, |_| panic!("unexpected observation")),
        Lookup::Miss(MissReason::TornRecord)
    );
    assert!(path.is_dir());
}

#[test]
fn a_fifo_at_the_record_path_is_torn_and_unlinked() {
    let (fixture, store, key, path) = record_fixture();
    fs::remove_file(&path).unwrap();
    let name = CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: name is a NUL-terminated path in this test's own store.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert_removed(&fixture, &store, &key, MissReason::TornRecord);
}

#[test]
fn a_symlink_at_the_record_path_is_torn_and_only_the_link_is_unlinked() {
    let (fixture, store, key, path) = record_fixture();
    let target = fixture.0.join("target");
    fs::rename(&path, &target).unwrap();
    symlink(&target, &path).unwrap();
    assert_removed(&fixture, &store, &key, MissReason::TornRecord);
    assert!(Record::decode(&fs::read(target).unwrap(), &key).is_ok());
}

#[test]
fn a_hard_link_at_the_record_path_is_torn_and_only_its_name_is_unlinked() {
    let (fixture, store, key, path) = record_fixture();
    let target = fixture.0.join("target");
    fs::hard_link(&path, &target).unwrap();
    assert_removed(&fixture, &store, &key, MissReason::TornRecord);
    assert!(Record::decode(&fs::read(target).unwrap(), &key).is_ok());
}

#[test]
fn a_record_with_the_wrong_mode_is_torn_and_unlinked() {
    for wrong_mode in [0o644, 0o000] {
        let (fixture, store, key, path) = record_fixture();
        fs::set_permissions(&path, fs::Permissions::from_mode(wrong_mode)).unwrap();
        assert_removed(&fixture, &store, &key, MissReason::TornRecord);
    }
}

#[test]
fn a_record_in_a_wrong_mode_shard_is_torn_and_left_in_place() {
    let (_fixture, store, key, path) = record_fixture();
    let shard = path.parent().unwrap();
    fs::set_permissions(shard, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        store.lookup(&key, |_| panic!("unexpected observation")),
        Lookup::Miss(MissReason::TornRecord)
    );
    assert_eq!(mode(shard), 0o755);
    assert!(path.is_file());
}

#[test]
fn a_symlinked_shard_is_unlinked_without_reading_its_target() {
    let (fixture, store, key, path) = record_fixture();
    let shard = path.parent().unwrap();
    let target = fixture.0.join("target");
    fs::rename(shard, &target).unwrap();
    symlink(&target, shard).unwrap();
    assert_eq!(
        store.lookup(&key, |_| panic!("unexpected observation")),
        Lookup::Miss(MissReason::TornRecord)
    );
    assert_eq!(
        fs::symlink_metadata(shard).unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
    assert!(target.join(path.file_name().unwrap()).is_file());
}

#[test]
fn cache_read_errors_are_misses_and_the_files_can_be_read_on_retry() {
    let (_fixture, store, key, _) = record_fixture();
    let digest = store
        .put_cas(&CasFixture {
            count: 2,
            identity: input(1),
        })
        .unwrap();
    disk::FAIL_CACHE_READ.set(true);
    let record = store.lookup(&key, |_| panic!("unexpected observation"));
    let object = store.get_cas(&digest);
    disk::FAIL_CACHE_READ.set(false);

    assert_eq!(record, Lookup::Miss(MissReason::TornRecord));
    assert_eq!(object, None);
    assert!(matches!(store.lookup(&key, |_| true), Lookup::Hit(_)));
    assert!(store.get_cas(&digest).is_some());
}

#[derive(Serialize)]
struct CasFixture {
    count: u32,
    identity: InputDigest,
}

impl ValueFree for CasFixture {}

#[test]
fn cas_hit_needs_object_and_never_calls_observe() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let key = example_key(StepClass::Cas);
    let value = CasFixture {
        count: 2,
        identity: input(1),
    };
    let digest = store.put_cas(&value).unwrap();
    assert_eq!(store.put_cas(&value).unwrap(), digest);
    let record = store
        .record(
            &key,
            Output {
                digest,
                reference: Some(OutputRef::Cas),
            },
            "run-1",
        )
        .unwrap();
    assert_eq!(
        store.lookup(&key, |_| panic!("unexpected observation")),
        Lookup::Hit(record)
    );
    fs::remove_file(cas_path(&fixture.root(), digest)).unwrap();
    assert_eq!(
        store.lookup(&key, |_| panic!("unexpected observation")),
        Lookup::Miss(MissReason::NoRecord)
    );
}

#[test]
fn observation_is_required_for_slot_boot_and_file_identity() {
    let fixture = Fixture::new();
    let store = fixture.open();
    for class in [StepClass::Slot, StepClass::Boot, StepClass::FileIdentity] {
        let key = example_key(class);
        let record = store.record(&key, output(None), "run-1").unwrap();
        assert_eq!(
            store.lookup(&key, |_| false),
            Lookup::Miss(MissReason::ObservationFailed)
        );
        assert_eq!(store.lookup(&key, |_| true), Lookup::Hit(record));
    }
}

#[test]
fn altered_cas_bytes_are_removed_and_reported_absent() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let value = CasFixture {
        count: 2,
        identity: input(1),
    };
    let digest = store.put_cas(&value).unwrap();
    let expected =
        canonical_digest::canonical_json(&serde_json::to_value(&value).unwrap()).unwrap();
    assert_eq!(store.get_cas(&digest), Some(expected));
    let path = cas_path(&fixture.root(), digest);
    fs::write(&path, b"{}").unwrap();
    assert!(store.get_cas(&digest).is_none());
    assert!(!path.exists());
}

#[test]
fn a_directory_at_the_cas_path_is_absent_and_left_in_place() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let digest = store
        .put_cas(&CasFixture {
            count: 2,
            identity: input(1),
        })
        .unwrap();
    let path = cas_path(&fixture.root(), digest);
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert_eq!(store.get_cas(&digest), None);
    assert!(path.is_dir());
}

#[test]
fn a_symlink_at_the_cas_path_is_absent_and_only_the_link_is_unlinked() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let digest = store
        .put_cas(&CasFixture {
            count: 2,
            identity: input(1),
        })
        .unwrap();
    let expected = store.get_cas(&digest).unwrap();
    let path = cas_path(&fixture.root(), digest);
    let target = fixture.0.join("target");
    fs::rename(&path, &target).unwrap();
    symlink(&target, &path).unwrap();
    assert_eq!(store.get_cas(&digest), None);
    assert_eq!(
        fs::symlink_metadata(path).unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
    assert_eq!(fs::read(target).unwrap(), expected);
}

#[test]
fn lookup_checks_large_cas_objects() {
    let fixture = Fixture::new();
    let store = fixture.open();
    // Enums have no fields that can carry an input value.
    #[derive(Clone, Serialize)]
    enum Marker {
        Present,
    }
    #[derive(Serialize)]
    struct Markers(Vec<Marker>);
    impl ValueFree for Markers {}

    let digest = store
        .put_cas(&Markers(vec![Marker::Present; 120_000]))
        .unwrap();
    let key = example_key(StepClass::Cas);
    store
        .record(
            &key,
            Output {
                digest,
                reference: Some(OutputRef::Cas),
            },
            "run-1",
        )
        .unwrap();
    let path = cas_path(&fixture.root(), digest);
    let mut bytes = store.get_cas(&digest).unwrap();
    assert!(bytes.len() > 1024 * 1024);
    bytes[1] = b' ';
    fs::write(&path, bytes).unwrap();
    assert_eq!(
        store.lookup(&key, |_| panic!("unexpected observation")),
        Lookup::Miss(MissReason::NoRecord)
    );
    assert!(!path.exists());
}

#[test]
fn only_a_hit_touches_an_hour_old_record() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let key = example_key(StepClass::Slot);
    store.record(&key, output(None), "run-1").unwrap();
    let path = record_path(&fixture.root(), &key);
    let file = File::open(path).unwrap();
    let aged = UNIX_EPOCH + Duration::from_secs(10_000);
    file.set_modified(aged).unwrap();
    let mtime = || file.metadata().unwrap().modified().unwrap();
    assert_eq!(
        store.lookup(&key, |_| false),
        Lookup::Miss(MissReason::ObservationFailed)
    );
    assert_eq!(mtime(), aged);
    assert!(matches!(store.lookup(&key, |_| true), Lookup::Hit(_)));
    let touched = mtime();
    assert!(touched > aged);
    assert!(matches!(store.lookup(&key, |_| true), Lookup::Hit(_)));
    assert_eq!(mtime(), touched);
}

/// True if any file under `path` contains `needle`.
fn store_contains(path: &Path, needle: &[u8]) -> bool {
    fs::read_dir(path).unwrap().any(|entry| {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            store_contains(&entry.path(), needle)
        } else {
            fs::read(entry.path())
                .unwrap()
                .windows(needle.len())
                .any(|window| window == needle)
        }
    })
}

/// The scan the end-to-end secret test will use (it lands with the first step that
/// stores a result, P2 on: a fixture whose env, managed env and files hold one
/// sentinel, then this scan). Here it is shown to find a value that does reach the
/// store, so a passing scan means something.
#[test]
fn the_store_scan_finds_a_value_that_was_written_into_it() {
    #[derive(Serialize)]
    struct Leaky {
        text: String,
    }
    impl ValueFree for Leaky {}
    let fixture = Fixture::new();
    let store = fixture.open();
    let sentinel = "synthetic-sentinel-written-on-purpose";
    assert!(!store_contains(&fixture.root(), sentinel.as_bytes()));
    store
        .put_cas(&Leaky {
            text: sentinel.into(),
        })
        .unwrap();
    assert!(store_contains(&fixture.root(), sentinel.as_bytes()));
}

/// No store API writes a raw input: keyed digests, keys and records made from a
/// sentinel never contain it (inputs are digests by type).
#[test]
fn keys_records_and_keyed_digests_never_carry_the_raw_input() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let sentinel = "synthetic-sentinel-for-step-store-non-persistence";
    let identity = InputDigest(store.keyed_digest(STEP, &json!(sentinel)).unwrap());
    let inputs = BTreeMap::from([("identity".into(), identity)]);
    let key = StepKey::new(
        "example",
        1,
        StepClass::Cas,
        &inputs,
        None,
        &baseline_build(),
    )
    .unwrap();
    let digest = store.put_cas(&CasFixture { count: 2, identity }).unwrap();
    let output = Output {
        digest,
        reference: Some(OutputRef::Cas),
    };
    store.record(&key, output, "run-1").unwrap();
    assert!(!store_contains(&fixture.root(), sentinel.as_bytes()));
}

#[test]
fn an_oversized_record_is_torn_and_an_oversized_cas_object_is_absent() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let key = example_key(StepClass::Slot);
    store.record(&key, output(None), "run-1").unwrap();
    let path = record_path(&fixture.root(), &key);
    let limit = usize::try_from(record::MAX_RECORD_BYTES).unwrap();
    fs::write(&path, vec![b' '; limit + 1]).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        store.lookup(&key, |_| true),
        Lookup::Miss(MissReason::TornRecord)
    );
    assert!(!path.exists());

    let digest = Digest([3; 32]);
    let object = cas_path(&fixture.root(), digest);
    fs::create_dir_all(object.parent().unwrap()).unwrap();
    fs::set_permissions(object.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
    let file = File::create(&object).unwrap();
    file.set_len(cas::MAX_CAS_BYTES + 1).unwrap();
    fs::set_permissions(&object, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(store.get_cas(&digest).is_none());
    assert!(!object.exists());
}

#[test]
fn get_cas_verifies_objects_of_any_size() {
    let fixture = Fixture::new();
    let store = fixture.open();
    #[derive(Clone, Serialize)]
    enum Marker {
        Present,
    }
    #[derive(Serialize)]
    struct Markers(Vec<Marker>);
    impl ValueFree for Markers {}
    let digest = store
        .put_cas(&Markers(vec![Marker::Present; 120_000]))
        .unwrap();
    let path = cas_path(&fixture.root(), digest);
    let mut bytes = fs::read(&path).unwrap();
    assert!(bytes.len() > 1024 * 1024);
    bytes[1] = b' ';
    fs::write(&path, bytes).unwrap();
    assert!(store.get_cas(&digest).is_none());
    assert!(!path.exists());
}

// Shared with the TypeScript twin (src/lib/step-store/, tests/step-store.test.ts).
const VECTORS: &str = include_str!("vectors.json");

fn vector_key(vector: &serde_json::Value) -> StepKey {
    let class: StepClass = serde_json::from_value(vector["class"].clone()).unwrap();
    let inputs: BTreeMap<String, InputDigest> =
        serde_json::from_value(vector["inputs"].clone()).unwrap();
    StepKey::new(
        vector["step"].as_str().unwrap(),
        u32::try_from(vector["stepVersion"].as_u64().unwrap()).unwrap(),
        class,
        &inputs,
        vector["epoch"].as_str(),
        &Build::named(vector["build"].as_str().unwrap()).unwrap(),
    )
    .unwrap()
}

#[test]
fn shared_key_vectors_match() {
    let vectors: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
    assert_eq!(vectors["schema"], "hack.step-store-vectors/1");
    let keys = vectors["keys"].as_array().unwrap();
    assert!(!keys.is_empty());
    for vector in keys {
        assert_eq!(
            vector_key(vector).digest().to_string(),
            vector["key"].as_str().unwrap(),
            "{}",
            vector["name"]
        );
    }
}

#[test]
fn shared_record_vectors_decode_and_reencode_byte_for_byte() {
    let vectors: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
    let records = vectors["records"].as_array().unwrap();
    assert!(!records.is_empty());
    for vector in records {
        let index = usize::try_from(vector["keyIndex"].as_u64().unwrap()).unwrap();
        let key = vector_key(&vectors["keys"][index]);
        let text = vector["text"].as_str().unwrap();
        let record = Record::decode(text.as_bytes(), &key).unwrap();
        assert_eq!(record.observed_at, vector["observedAt"].as_u64().unwrap());
        assert_eq!(record.produced_by.run, vector["run"].as_str().unwrap());
        assert_eq!(
            serde_json::to_value(&record.output).unwrap(),
            vector["output"],
            "{}",
            vector["name"]
        );
        assert_eq!(
            String::from_utf8(record.encode().unwrap()).unwrap(),
            text,
            "{}",
            vector["name"]
        );
    }
}

#[test]
fn step_store_argument_is_optional_and_needs_an_absolute_directory() {
    let plain = ["runtime", "up"];
    assert_eq!(take_step_store_argument(&plain).unwrap(), plain);
    assert!(take_step_store_argument(&["--step-store"]).is_err());
    assert!(take_step_store_argument(&["--step-store", "relative/store", "info"]).is_err());
    // The only call that records a directory (it is process-wide, set once).
    let rest = take_step_store_argument(&["--step-store", "/tmp/hack-store-arg", "info"]).unwrap();
    assert_eq!(rest, ["info"]);
    assert_eq!(configured_root(), Some(Path::new("/tmp/hack-store-arg")));
    assert!(take_step_store_argument(&["--step-store", "/tmp/other", "info"]).is_err());
}

#[test]
fn a_torn_key_before_version_is_an_aborted_initialization_and_is_replaced() {
    for size in [0, 7, 31] {
        let fixture = Fixture::new();
        drop(fixture.open());
        // As if the first open died after a partial key and before VERSION.
        fs::remove_file(fixture.root().join("VERSION")).unwrap();
        fs::write(fixture.root().join("key"), vec![1; size]).unwrap();
        fs::set_permissions(
            fixture.root().join("key"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let store = fixture.open();
        assert_eq!(fs::metadata(fixture.root().join("key")).unwrap().len(), 32);
        assert_eq!(
            fs::read(fixture.root().join("VERSION")).unwrap(),
            b"hack.store/1\n"
        );
        assert!(store.keyed_digest(STEP, &json!("x")).is_ok());
    }
}

#[test]
fn a_key_is_published_whole_and_no_key_file_is_written_in_place() {
    let fixture = Fixture::new();
    drop(fixture.open());
    let key = fs::read(fixture.root().join("key")).unwrap();
    assert_eq!(key.len(), 32);
    // A leftover temporary from a crashed publication never becomes the key.
    fs::write(fixture.root().join("tmp").join("leftover"), [9; 32]).unwrap();
    drop(fixture.open());
    assert_eq!(fs::read(fixture.root().join("key")).unwrap(), key);
}

#[test]
fn non_canonical_records_and_missing_fields_are_torn() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let key = example_key(StepClass::Slot);
    let output = Output {
        digest: Digest([7; 32]),
        reference: None,
    };
    let written = store.record(&key, output, "run-1").unwrap();
    let text = String::from_utf8(written.encode().unwrap()).unwrap();
    let path = record_path(&fixture.root(), &key);
    let mut without_epoch: serde_json::Value = serde_json::from_str(&text).unwrap();
    without_epoch.as_object_mut().unwrap().remove("epoch");
    without_epoch.as_object_mut().unwrap().remove("check");
    let check = crate::canonical_digest::digest(STEP_RECORD, &without_epoch).unwrap();
    without_epoch["check"] = json!(check.to_string());
    for torn in [
        format!("{text} "),
        text.replace("\"stepVersion\":1", "\"stepVersion\":1.0"),
        text.replace("\"v\":1", "\"v\":1.0"),
        String::from_utf8(crate::canonical_digest::canonical_json(&without_epoch).unwrap())
            .unwrap(),
    ] {
        fs::write(&path, &torn).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            store.lookup(&key, |_| true),
            Lookup::Miss(MissReason::TornRecord)
        );
        assert!(!path.exists());
    }
}

#[test]
fn build_epoch_and_run_are_bounded_identifiers() {
    let long = "a".repeat(129);
    for build in ["", "/path/to/build", "value=secret", &long] {
        assert_eq!(Build::named(build).unwrap_err().code, "step_store_invalid");
    }
    let build = Build::named("5.0.0+g1").unwrap();
    for epoch in ["", "has space", &long] {
        assert!(
            StepKey::new(
                "example-step",
                1,
                StepClass::Boot,
                &inputs(),
                Some(epoch),
                &build
            )
            .is_err()
        );
    }
    assert!(
        StepKey::new(
            "example-step",
            1,
            StepClass::Boot,
            &inputs(),
            Some("boot:1_a+b.c-d"),
            &build
        )
        .is_ok()
    );
    let fixture = Fixture::new();
    let store = fixture.open();
    let key = example_key(StepClass::Slot);
    for run in ["", "run with space", "run/1"] {
        let output = Output {
            digest: Digest([7; 32]),
            reference: None,
        };
        assert!(store.record(&key, output, run).is_err());
    }
}

#[test]
fn a_rechecked_record_with_an_invalid_run_or_unsafe_time_is_torn() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let key = example_key(StepClass::Slot);
    let output = Output {
        digest: Digest([7; 32]),
        reference: None,
    };
    let written = store.record(&key, output, "run-1").unwrap();
    let path = record_path(&fixture.root(), &key);
    let base: serde_json::Value = serde_json::from_slice(&written.encode().unwrap()).unwrap();
    for (field, value) in [
        ("run", json!("run with space")),
        ("run", json!("")),
        ("observedAt", json!(9_007_199_254_740_993_u64)),
    ] {
        let mut record = base.clone();
        record.as_object_mut().unwrap().remove("check");
        if field == "run" {
            record["producedBy"]["run"] = value;
        } else {
            record[field] = value;
        }
        let check = crate::canonical_digest::digest(STEP_RECORD, &record).unwrap();
        record["check"] = json!(check.to_string());
        fs::write(
            &path,
            crate::canonical_digest::canonical_json(&record).unwrap(),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            store.lookup(&key, |_| true),
            Lookup::Miss(MissReason::TornRecord)
        );
    }
}

#[test]
fn shared_refused_record_vectors_are_refused_with_their_reason() {
    let vectors: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
    let refused = vectors["refused"].as_array().unwrap();
    assert!(!refused.is_empty());
    for vector in refused {
        let index = usize::try_from(vector["keyIndex"].as_u64().unwrap()).unwrap();
        let key = vector_key(&vectors["keys"][index]);
        let expected = match vector["expect"].as_str().unwrap() {
            "torn-record" => MissReason::TornRecord,
            "version-changed" => MissReason::VersionChanged,
            other => panic!("unknown reason {other}"),
        };
        assert_eq!(
            Record::decode(vector["text"].as_str().unwrap().as_bytes(), &key),
            Err(expected),
            "{}",
            vector["name"]
        );
    }
}

fn many_inputs(count: usize) -> BTreeMap<String, InputDigest> {
    (0..count)
        .map(|index| (format!("input-{index:058}"), input(1)))
        .collect()
}

#[test]
fn a_key_with_maximum_inputs_and_identifiers_fits_in_a_record() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let key = StepKey::new(
        &"s".repeat(64),
        u32::MAX,
        StepClass::FileIdentity,
        &many_inputs(256),
        Some(&"e".repeat(128)),
        &Build::named(&"b".repeat(128)).unwrap(),
    )
    .unwrap();
    let mut written = store
        .record(&key, output(Some(OutputRef::Cas)), &"r".repeat(128))
        .unwrap();
    written.observed_at = 9_007_199_254_740_991;
    let encoded = written.encode().unwrap();
    assert!(encoded.len() <= 64 * 1024);
    assert_eq!(Record::decode(&encoded, &key), Ok(written));
}

#[test]
fn a_key_with_more_than_256_inputs_is_refused() {
    let error = StepKey::new(
        "example-step",
        1,
        StepClass::Slot,
        &many_inputs(257),
        None,
        &baseline_build(),
    )
    .unwrap_err();
    assert_eq!(error.code, "step_store_invalid");
}

#[test]
fn a_record_too_large_to_read_back_is_refused_before_it_is_written() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let mut key = example_key(StepClass::Slot);
    key.inputs = many_inputs(600);
    assert!(store.record(&key, output(None), "run-1").is_err());
    assert!(!record_path(&fixture.root(), &key).exists());
}

#[test]
fn the_current_build_uses_the_running_images_embedded_identity() {
    let key = StepKey::new(
        "example-step",
        1,
        StepClass::Slot,
        &inputs(),
        None,
        &Build::current().unwrap(),
    )
    .unwrap();
    assert_eq!(
        key.build,
        format!(
            "{}+{}:{}",
            crate::CANDIDATE_VERSION,
            env!("CARGO_PKG_VERSION"),
            env!("HACK_RUNTIME_BUILD_ID"),
        )
    );
}

/// The flat migration renames VERSION to its migrating marker, removes the key and
/// the lock, and removes the marker last.
#[test]
fn flat_migration_removes_its_marker_last() {
    let fixture = Fixture::new();
    drop(fixture.open());
    let base = fixture.base();
    write_legacy_markers(&base);
    fs::write(base.join("key"), b"legacy").unwrap();
    disk::FLAT_FINAL_REMOVALS.with_borrow_mut(Vec::clear);
    drop(fixture.open());
    assert_eq!(
        disk::FLAT_FINAL_REMOVALS.with_borrow(Clone::clone),
        ["VERSION.migrating", "key", "lock", "marker"]
    );
    for name in ["VERSION", "VERSION.migrating", "key", "lock"] {
        assert!(!base.join(name).exists(), "{name} left behind");
    }
}

/// A migration interrupted after any step is finished by the next open, and at
/// no point does a P1 opener see a published VERSION without its key and lock.
#[test]
fn an_interrupted_flat_migration_is_finished_by_a_later_open() {
    for stop in ["VERSION.migrating", "key", "lock"] {
        let fixture = Fixture::new();
        drop(fixture.open());
        let base = fixture.base();
        write_legacy_markers(&base);
        fs::write(base.join("key"), b"legacy").unwrap();
        fs::create_dir(base.join("records")).unwrap();
        disk::STOP_FLAT_AFTER.set(Some(stop));
        drop(fixture.open());
        disk::STOP_FLAT_AFTER.set(None);
        if base.join("VERSION").exists() {
            assert!(
                base.join("key").exists() && base.join("lock").exists(),
                "after {stop}"
            );
        }
        assert!(
            base.join("VERSION.migrating").exists(),
            "marker missing after {stop}"
        );
        drop(fixture.open());
        for name in ["VERSION", "VERSION.migrating", "key", "lock", "records"] {
            assert!(!base.join(name).exists(), "{name} left after {stop}");
        }
    }
}

/// A genuine archive opened as another store's base, in another process that holds
/// that store's lock (`hack.store-1/lock` inside the archive), is kept by cleanup.
#[test]
fn an_archive_opened_as_another_stores_base_is_kept() {
    let fixture = Fixture::new();
    drop(fixture.open());
    // Make a genuine archive of the first store, then open a second store inside it.
    let archived_at = disk::unix_millis().unwrap();
    disk::set_aside(&fixture.base(), &fixture.root(), archived_at).unwrap();
    let archive = fixture
        .base()
        .join(format!("{}.old-{archived_at}", disk::FORMAT_DIRECTORY));
    assert!(archive.join("SET_ASIDE").is_file());
    // Age it past seven days so cleanup would otherwise remove it.
    let aged = archive.with_file_name(format!("{}.old-1", disk::FORMAT_DIRECTORY));
    fs::rename(&archive, &aged).unwrap();
    let marker = fs::read_to_string(aged.join("SET_ASIDE")).unwrap();
    fs::write(
        aged.join("SET_ASIDE"),
        marker.replace(&format!("at={archived_at}"), "at=1"),
    )
    .unwrap();
    fs::set_permissions(aged.join("SET_ASIDE"), fs::Permissions::from_mode(0o600)).unwrap();
    // Another process opens a store with the archive as its base and keeps it
    // open: it holds `hack.store-1/lock` inside the archive.
    let mut holder = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "store::tests::child_store_opener",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("HACK_STORE_TEST_ROOT", &aged)
        .env("HACK_STORE_TEST_HOLD_MS", "4000")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    // Wait until the child has opened its store (it prints its digest then).
    let deadline = Instant::now() + Duration::from_secs(15);
    while !aged.join(disk::FORMAT_DIRECTORY).join("VERSION").is_file() {
        assert!(
            Instant::now() < deadline,
            "the holder did not open its store"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(200));
    drop(fixture.open());
    let kept = aged.join(disk::FORMAT_DIRECTORY).is_dir();
    let _ = holder.kill();
    let _ = holder.wait();
    assert!(kept, "cleanup removed an archive holding a live store");
}

/// A flat directory that cannot be removed (here a symlinked `records`) keeps
/// VERSION, the key and the lock together: a P1 process opening the base later
/// must never see VERSION without its key, which would make it set the whole
/// base aside, live `hack.store-1` included.
#[test]
fn a_flat_entry_that_cannot_be_removed_keeps_version_key_and_lock_together() {
    let fixture = Fixture::new();
    let live = fixture.open();
    let base = fixture.base();
    write_legacy_markers(&base);
    fs::write(base.join("key"), [7; 32]).unwrap();
    let elsewhere = fixture.0.join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    symlink(&elsewhere, base.join("records")).unwrap();
    disk::FLAT_FINAL_REMOVALS.with_borrow_mut(Vec::clear);
    drop(fixture.open());
    assert!(disk::FLAT_FINAL_REMOVALS.with_borrow(Vec::is_empty));
    for name in ["VERSION", "key", "lock"] {
        assert!(base.join(name).exists(), "{name} was removed");
    }
    assert!(elsewhere.is_dir());
    assert!(live.keyed_digest(STEP, &json!(1)).is_ok());
}
