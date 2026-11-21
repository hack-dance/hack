use super::*;
use crate::canonical_digest::{STEP, STEP_RECORD};
use crate::provider::state::flock;
use crate::test_root::private_test_root;
use serde::Serialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::sync::Barrier;
use std::time::{Duration, UNIX_EPOCH};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self(private_test_root(
            &fs::canonicalize(std::env::temp_dir()).unwrap(),
            "hack-step-store",
        ))
    }

    fn root(&self) -> PathBuf {
        self.0.join("store")
    }

    fn open(&self) -> Store {
        Store::open(&self.root()).unwrap()
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
fn open_creates_private_layout_and_holds_shared_lock_until_drop() {
    let fixture = Fixture::new();
    let first = fixture.open();
    let second = fixture.open();
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
    flock(&lock, libc::LOCK_EX | libc::LOCK_NB).unwrap();
}

#[test]
fn concurrent_first_opens_share_one_generation_and_key() {
    let fixture = Fixture::new();
    let start = Barrier::new(8);
    let stores = std::thread::scope(|scope| {
        (0..8)
            .map(|_| {
                scope.spawn(|| {
                    start.wait();
                    fixture.open()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>()
    });
    let value = json!(42);
    let expected = stores[0].keyed_digest(STEP, &value).unwrap();
    for store in &stores {
        assert_eq!(store.keyed_digest(STEP, &value).unwrap(), expected);
    }
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
    let old = fixture.open();
    let key = example_key(StepClass::Slot);
    old.record(&key, output(None), "run-1").unwrap();
    let old_digest = old.keyed_digest(STEP, &json!(42)).unwrap();
    drop(old);
    fs::write(fixture.root().join("VERSION"), b"hack.store/2\n").unwrap();
    let fresh = fixture.open();
    assert_ne!(fresh.keyed_digest(STEP, &json!(42)).unwrap(), old_digest);
    assert_eq!(
        fs::read(fixture.root().join("VERSION")).unwrap(),
        b"hack.store/1\n"
    );
    assert_eq!(
        fresh
            .lookup(&key, |_| panic!("unexpected observation"))
            .unwrap(),
        Lookup::Miss(MissReason::NoRecord)
    );
    let archive = fs::read_dir(&fixture.0)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("store.old-")
        })
        .unwrap();
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
fn wrong_key_mode_is_refused() {
    let fixture = Fixture::new();
    drop(fixture.open());
    fs::set_permissions(
        fixture.root().join("key"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert_open_refused(&fixture.root());
}

#[test]
fn wrong_key_sizes_are_refused() {
    let fixture = Fixture::new();
    drop(fixture.open());
    for size in [31, 33] {
        fs::write(fixture.root().join("key"), vec![0; size]).unwrap();
        assert_open_refused(&fixture.root());
    }
}

#[test]
fn symlink_and_directory_keys_are_refused() {
    let fixture = Fixture::new();
    let other = Fixture::new();
    drop(fixture.open());
    drop(other.open());
    let path = fixture.root().join("key");
    fs::remove_file(&path).unwrap();
    symlink(other.root().join("key"), &path).unwrap();
    assert_open_refused(&fixture.root());
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert_open_refused(&fixture.root());
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

fn example_key(class: StepClass) -> StepKey {
    StepKey::new("example-step", 1, class, &inputs(), None, "build-1").unwrap()
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
        "build-1",
    )
    .unwrap();
    assert_eq!(key.digest(), baseline_key());
}

#[test]
fn step_name_changes_key() {
    let key = StepKey::new("other", 1, StepClass::Slot, &inputs(), None, "build-1").unwrap();
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
        "build-1",
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
            "build-1",
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
            "build-1",
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
        "build-1",
    )
    .unwrap();
    let other = StepKey::new(
        "example-step",
        1,
        StepClass::Slot,
        &inputs(),
        Some("boot-2"),
        "build-1",
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
        "build-2",
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
        let step = StepKey::new(name, 1, class, &inputs(), None, "build-1").unwrap_err();
        let input_name = BTreeMap::from([(name.into(), input(1))]);
        let input = StepKey::new("valid", 1, class, &input_name, None, "build-1").unwrap_err();
        assert_eq!(step.code, "step_store_invalid");
        assert_eq!(input.code, "step_store_invalid");
    }
    let bound = format!("0{}", ".-a".repeat(21));
    let named = BTreeMap::from([(bound.clone(), input(1))]);
    assert!(StepKey::new(&bound, 1, class, &named, None, "build-1").is_ok());
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
        reopened.lookup(&key, |found| found == &record).unwrap(),
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
        let other =
            StepKey::new(step, version, StepClass::Slot, &inputs(), None, "build-1").unwrap();
        let path = record_path(&fixture.root(), &other);
        disk::create_directory(path.parent().unwrap()).unwrap();
        fs::write(path, &bytes).unwrap();
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
    let miss = store
        .lookup(key, |_| panic!("unexpected observation"))
        .unwrap();
    assert_eq!(miss, Lookup::Miss(reason));
    assert!(!record_path(&fixture.root(), key).exists());
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
        store
            .lookup(&key, |_| panic!("unexpected observation"))
            .unwrap(),
        Lookup::Hit(record)
    );
    fs::remove_file(cas_path(&fixture.root(), digest)).unwrap();
    assert_eq!(
        store
            .lookup(&key, |_| panic!("unexpected observation"))
            .unwrap(),
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
            store.lookup(&key, |_| false).unwrap(),
            Lookup::Miss(MissReason::ObservationFailed)
        );
        assert_eq!(store.lookup(&key, |_| true).unwrap(), Lookup::Hit(record));
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
    assert_eq!(store.get_cas(&digest).unwrap(), Some(expected));
    let path = cas_path(&fixture.root(), digest);
    fs::write(&path, b"{}").unwrap();
    assert!(store.get_cas(&digest).unwrap().is_none());
    assert!(!path.exists());
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
    let mut bytes = store.get_cas(&digest).unwrap().unwrap();
    assert!(bytes.len() > 1024 * 1024);
    bytes[1] = b' ';
    fs::write(&path, bytes).unwrap();
    assert_eq!(
        store
            .lookup(&key, |_| panic!("unexpected observation"))
            .unwrap(),
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
        store.lookup(&key, |_| false).unwrap(),
        Lookup::Miss(MissReason::ObservationFailed)
    );
    assert_eq!(mtime(), aged);
    assert!(matches!(
        store.lookup(&key, |_| true).unwrap(),
        Lookup::Hit(_)
    ));
    let touched = mtime();
    assert!(touched > aged);
    assert!(matches!(
        store.lookup(&key, |_| true).unwrap(),
        Lookup::Hit(_)
    ));
    assert_eq!(mtime(), touched);
}

#[test]
fn no_store_bytes_contain_the_keyed_input_value() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let sentinel = "synthetic-sentinel-for-step-store-non-persistence";
    let identity = InputDigest(store.keyed_digest(STEP, &json!(sentinel)).unwrap());
    let inputs = BTreeMap::from([("identity".into(), identity)]);
    let key = StepKey::new("example", 1, StepClass::Cas, &inputs, None, "build-1").unwrap();
    let digest = store.put_cas(&CasFixture { count: 2, identity }).unwrap();
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

    fn scan(path: &Path, sentinel: &[u8]) {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                scan(&entry.path(), sentinel);
            } else {
                let bytes = fs::read(entry.path()).unwrap();
                assert!(
                    !bytes
                        .windows(sentinel.len())
                        .any(|window| window == sentinel)
                );
            }
        }
    }
    scan(&fixture.root(), sentinel.as_bytes());
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
        vector["build"].as_str().unwrap(),
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
            store.lookup(&key, |_| true).unwrap(),
            Lookup::Miss(MissReason::TornRecord)
        );
        assert!(!path.exists());
    }
}

#[test]
fn build_epoch_and_run_are_bounded_identifiers() {
    for (epoch, build) in [
        (Some(""), "build-1"),
        (Some("has space"), "build-1"),
        (None, ""),
        (None, "/path/to/build"),
        (None, "value=secret"),
    ] {
        assert!(StepKey::new("example-step", 1, StepClass::Boot, &inputs(), epoch, build).is_err());
    }
    let long = "a".repeat(129);
    assert!(
        StepKey::new(
            "example-step",
            1,
            StepClass::Boot,
            &inputs(),
            Some(&long),
            "b"
        )
        .is_err()
    );
    assert!(
        StepKey::new(
            "example-step",
            1,
            StepClass::Boot,
            &inputs(),
            Some("boot:1_a+b.c-d"),
            "5.0.0+g1"
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
            store.lookup(&key, |_| true).unwrap(),
            Lookup::Miss(MissReason::TornRecord)
        );
    }
}
