use super::super::{DirectoryIdentity, VolumeIdentity};
use super::*;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::rc::Rc;
use std::sync::atomic::AtomicU64;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        let path = base.join(format!(
            "native-persistent-enroll-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }
    fn slot(&self) -> PathBuf {
        self.0.join(slot_name(&binding()))
    }
    fn record(&self) -> Value {
        serde_json::from_slice(&fs::read(self.slot().join("owner.json")).unwrap()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn binding() -> Binding {
    serde_json::from_value(json!({
        "scope":{"namespace":"a".repeat(64),"storage":"db_data","owner":"b".repeat(32)},
        "guest":{"owner":"c".repeat(32),"boot_id":"11111111-2222-3333-4444-555555555555",
            "storage":{"device":0,"inode":25,"bytes":8192,"uuid":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}},
        "policy":{"driver":"local","scope":"local","options":{}}
    })).unwrap()
}
fn observation() -> Observation {
    Observation {
        binding: binding(),
        volume: VolumeIdentity {
            name: volume_name(&binding()),
            created_at: "2026-10-08T12:34:56.123456789Z".into(),
            directory: DirectoryIdentity {
                device: 0,
                inode: 91,
            },
        },
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Event {
    Verify(usize),
    Inspect(usize),
    Create,
}
struct Fake {
    current: BTreeMap<String, Observation>,
    verifies: usize,
    inspects: usize,
    creates: usize,
    fail_create: bool,
    replace_after_create: bool,
    fail: Option<Event>,
    hook: Option<Box<dyn FnMut(Event)>>,
}
impl Fake {
    fn new() -> Self {
        Self {
            current: BTreeMap::new(),
            verifies: 0,
            inspects: 0,
            creates: 0,
            fail_create: false,
            replace_after_create: false,
            fail: None,
            hook: None,
        }
    }
    fn event(&mut self, event: Event) {
        if let Some(hook) = &mut self.hook {
            hook(event);
        }
    }
}
impl sealed::Transport for Fake {}
impl Transport for Fake {
    fn verify(&mut self, expected: &Binding, deadline: Instant) -> Result<(), CandidateError> {
        self.verifies += 1;
        self.event(Event::Verify(self.verifies));
        if self.fail == Some(Event::Verify(self.verifies)) {
            return Err(canary());
        }
        if *expected != binding() || Instant::now() >= deadline {
            return Err(refused());
        }
        Ok(())
    }
    fn inspect(
        &mut self,
        name: &str,
        deadline: Instant,
    ) -> Result<Option<Observation>, CandidateError> {
        self.inspects += 1;
        self.event(Event::Inspect(self.inspects));
        if self.fail == Some(Event::Inspect(self.inspects)) {
            return Err(canary());
        }
        if Instant::now() >= deadline {
            return Err(refused());
        }
        Ok(self.current.get(name).cloned())
    }
    fn create_new(
        &mut self,
        request: &CreateRequest,
        deadline: Instant,
    ) -> Result<Observation, CandidateError> {
        self.creates += 1;
        self.event(Event::Create);
        if Instant::now() >= deadline || self.current.contains_key(request.name()) {
            return Err(refused());
        }
        assert!(request.binding() == &binding());
        assert_eq!(request.intent(), "d".repeat(32));
        let created = observation();
        self.current.insert(request.name().into(), created.clone());
        if self.replace_after_create {
            self.current
                .get_mut(request.name())
                .unwrap()
                .volume
                .directory
                .inode += 1;
        }
        if self.fail_create {
            return Err(canary());
        }
        Ok(created)
    }
}
fn canary() -> CandidateError {
    CandidateError::new("adapter-private-canary", "private-value-canary/path/volume")
        .with_cause_code("private-cause-canary".into())
}
struct FaultSync {
    fail: Option<Step>,
    seen: Rc<RefCell<Vec<Step>>>,
}
impl Sync for FaultSync {
    fn sync(&mut self, file: &File, step: Step) -> Result<(), CandidateError> {
        self.seen.borrow_mut().push(step);
        if self.fail == Some(step) {
            return Err(refused());
        }
        file.sync_all().map_err(|_| refused())
    }
}
fn options<'a>(
    fixture: &'a Fixture,
    binding: &'a Binding,
    cancelled: &'a AtomicBool,
) -> EnrollOptions<'a> {
    EnrollOptions {
        state_root: &fixture.0,
        binding,
        intent: "dddddddddddddddddddddddddddddddd",
        deadline: Instant::now() + Duration::from_secs(10),
        cancelled,
    }
}
fn read(fixture: &Fixture, binding: &Binding, fake: &mut Fake) -> Result<Owner, CandidateError> {
    read_retained(
        ReadOptions {
            state_root: &fixture.0,
            binding,
            deadline: Instant::now() + Duration::from_secs(10),
            cancelled: &AtomicBool::new(false),
        },
        fake,
    )
}
fn enroll_fixture(fixture: &Fixture, fake: &mut Fake) -> Owner {
    enroll_new(options(fixture, &binding(), &AtomicBool::new(false)), fake).unwrap()
}

#[test]
fn durable_pending_precedes_the_original_effect_and_retained_reads_do_not_rebind_generations() {
    let fixture = Fixture::new();
    let seen = Rc::new(RefCell::new(Vec::new()));
    let at_create = seen.clone();
    let slot = fixture.slot();
    let mut fake = Fake::new();
    fake.hook = Some(Box::new(move |event| {
        if event == Event::Create {
            assert!(
                *at_create.borrow()
                    == vec![
                        Step::SlotDirectory,
                        Step::LockFile,
                        Step::PendingFile,
                        Step::PendingDirectory
                    ]
            );
            let bytes = fs::read(slot.join("owner.json")).unwrap();
            let pending = super::super::decode(&bytes).unwrap();
            assert!(
                super::super::compare(CompareOptions {
                    record: &pending,
                    expected: &binding(),
                    observed: Some(&observation())
                })
                .is_err()
            );
            assert_eq!(
                fs::metadata(slot.join("owner.json")).unwrap().mode() & 0o777,
                0o600
            );
        }
    }));
    let enrolled = enroll(
        options(&fixture, &binding(), &AtomicBool::new(false)),
        &mut fake,
        &mut FaultSync { fail: None, seen },
    )
    .unwrap();
    let original = fs::read(fixture.slot().join("owner.json")).unwrap();
    let original_inode = fs::metadata(fixture.slot().join("owner.json"))
        .unwrap()
        .ino();
    assert_eq!(fake.creates, 1);
    assert_eq!(serde_json::to_value(enrolled).unwrap(), fixture.record());
    fake.hook = None;
    for run in ["1".repeat(32), "2".repeat(32)] {
        let scope = crate::provider::native_input::Scope {
            namespace: &binding().scope.namespace,
            run: &run,
        };
        let mut expected = binding();
        expected.scope.namespace = scope.namespace.into();
        assert!(read(&fixture, &expected, &mut fake).is_ok());
    }
    assert_eq!(fake.creates, 1);
    assert_eq!(
        fs::read(fixture.slot().join("owner.json")).unwrap(),
        original
    );
    assert_eq!(
        fs::metadata(fixture.slot().join("owner.json"))
            .unwrap()
            .ino(),
        original_inode
    );
    assert!(!String::from_utf8(original).unwrap().contains("\"run\""));
}

#[test]
fn preexisting_names_slots_and_pending_never_gain_enrollment_or_a_second_effect() {
    let fixture = Fixture::new();
    let mut fake = Fake::new();
    fake.current.insert(volume_name(&binding()), observation());
    assert!(
        enroll_new(
            options(&fixture, &binding(), &AtomicBool::new(false)),
            &mut fake
        )
        .is_err()
    );
    assert_eq!(fake.creates, 0);
    assert!(!fixture.slot().exists());
    fake.current.clear();
    fake.fail_create = true;
    assert!(
        enroll_new(
            options(&fixture, &binding(), &AtomicBool::new(false)),
            &mut fake
        )
        .is_err()
    );
    let original = fs::read(fixture.slot().join("owner.json")).unwrap();
    assert_eq!(fixture.record()["enrollment"]["status"], "pending");
    assert!(read(&fixture, &binding(), &mut fake).is_err());
    fake.current.clear(); // Even apparent engine absence cannot recover an old attempt.
    fake.fail_create = false;
    assert!(
        enroll_new(
            options(&fixture, &binding(), &AtomicBool::new(false)),
            &mut fake
        )
        .is_err()
    );
    assert_eq!(fake.creates, 1);
    assert_eq!(
        fs::read(fixture.slot().join("owner.json")).unwrap(),
        original
    );
    assert!(fixture.slot().join("operation.lock").is_file());
}

#[test]
fn adapter_errors_are_normalized_before_return_including_ambiguous_original_create() {
    for event in [
        Event::Verify(1),
        Event::Inspect(1),
        Event::Create,
        Event::Inspect(3),
    ] {
        let fixture = Fixture::new();
        let mut fake = Fake::new();
        if event == Event::Create {
            fake.fail_create = true;
        } else {
            fake.fail = Some(event);
        }
        let error = enroll_new(
            options(&fixture, &binding(), &AtomicBool::new(false)),
            &mut fake,
        )
        .err()
        .unwrap();
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            json!({
                "code": "native_persistent_data_enrollment",
                "message": "Persistent data enrollment is incomplete, ambiguous or changed; retained data was not adopted or deleted."
            })
        );
        assert!(!serde_json::to_string(&error).unwrap().contains("private-"));
        if fake.creates > 0 {
            assert_eq!(fixture.record()["enrollment"]["status"], "pending");
            assert_eq!(fake.current.len(), 1);
        }
    }
    let fixture = Fixture::new();
    let mut fake = Fake::new();
    enroll_fixture(&fixture, &mut fake);
    fake.fail = Some(Event::Inspect(fake.inspects + 1));
    let before = fs::read(fixture.slot().join("owner.json")).unwrap();
    let error = read(&fixture, &binding(), &mut fake).err().unwrap();
    assert_eq!(
        serde_json::to_value(&error).unwrap(),
        serde_json::to_value(refused()).unwrap()
    );
    assert_eq!(fs::read(fixture.slot().join("owner.json")).unwrap(), before);
    assert_eq!(fake.creates, 1);
}

#[test]
fn pending_sync_failure_prevents_create_and_final_sync_failure_is_uncertain() {
    for step in [
        Step::PendingFile,
        Step::PendingDirectory,
        Step::EnrolledFile,
        Step::CommittedDirectory,
    ] {
        let fixture = Fixture::new();
        let mut fake = Fake::new();
        let result = enroll(
            options(&fixture, &binding(), &AtomicBool::new(false)),
            &mut fake,
            &mut FaultSync {
                fail: Some(step),
                seen: Rc::new(RefCell::new(Vec::new())),
            },
        );
        assert!(result.is_err());
        assert_eq!(
            fake.creates,
            usize::from(matches!(
                step,
                Step::EnrolledFile | Step::CommittedDirectory
            ))
        );
        let status = if step == Step::CommittedDirectory {
            "enrolled"
        } else {
            "pending"
        };
        assert_eq!(fixture.record()["enrollment"]["status"], status);
        // An enrolled pathname after failed final sync is an observation of uncertain
        // publication, not successful-return evidence or permission to repeat creation.
        assert!(
            enroll_new(
                options(&fixture, &binding(), &AtomicBool::new(false)),
                &mut fake
            )
            .is_err()
        );
    }
}

#[test]
fn captured_original_identity_cannot_be_replaced_by_copied_labels_or_a_new_directory() {
    let fixture = Fixture::new();
    let mut fake = Fake::new();
    fake.replace_after_create = true;
    assert!(
        enroll_new(
            options(&fixture, &binding(), &AtomicBool::new(false)),
            &mut fake
        )
        .is_err()
    );
    assert_eq!(fake.creates, 1);
    assert_eq!(fixture.record()["enrollment"]["status"], "pending");
    assert_eq!(
        fake.current.values().next().unwrap().volume.directory.inode,
        92
    );
    assert!(!fixture.slot().join("owner.next").exists());
}

#[test]
fn invalid_input_expiration_and_cancel_refuse_before_any_file_or_create() {
    let fixture = Fixture::new();
    let mut fake = Fake::new();
    let cancelled = AtomicBool::new(false);
    let mut invalid = binding();
    invalid.scope.storage = "../unowned".into();
    assert!(enroll_new(options(&fixture, &invalid, &cancelled), &mut fake).is_err());
    let valid = binding();
    let mut expired = options(&fixture, &valid, &cancelled);
    expired.deadline = Instant::now();
    assert!(enroll_new(expired, &mut fake).is_err());
    cancelled.store(true, Ordering::SeqCst);
    assert!(enroll_new(options(&fixture, &valid, &cancelled), &mut fake).is_err());
    assert_eq!(fake.verifies, 0);
    assert_eq!(fake.creates, 0);
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
}

#[test]
fn post_effect_record_lock_and_root_replacements_refuse_without_adopting_or_deleting() {
    for target in ["owner.json", "operation.lock", "root"] {
        let fixture = Fixture::new();
        let slot = fixture.slot();
        let root = fixture.0.clone();
        let mut fake = Fake::new();
        fake.hook = Some(Box::new(move |event| {
            if event == Event::Create {
                if target == "root" {
                    fs::rename(&root, root.with_extension("old")).unwrap();
                    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
                    fs::rename(root.with_extension("old"), root.join("retained-original")).unwrap();
                } else {
                    let path = slot.join(target);
                    let bytes = fs::read(&path).unwrap();
                    fs::rename(&path, slot.join(format!("{target}.old"))).unwrap();
                    let mut replacement = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .mode(0o600)
                        .open(&path)
                        .unwrap();
                    replacement.write_all(&bytes).unwrap();
                }
            }
        }));
        assert!(
            enroll_new(
                options(&fixture, &binding(), &AtomicBool::new(false)),
                &mut fake
            )
            .is_err()
        );
        assert_eq!(fake.creates, 1);
        assert_eq!(fake.current.len(), 1);
        assert!(!fixture.slot().join("owner.next").exists());
    }
}

#[test]
fn retained_read_is_existing_only_and_refuses_missing_lock_staging_birth_or_guest_drift() {
    let fixture = Fixture::new();
    let mut fake = Fake::new();
    assert!(read(&fixture, &binding(), &mut fake).is_err());
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
    enroll_fixture(&fixture, &mut fake);
    let original = fs::read(fixture.slot().join("owner.json")).unwrap();
    let lock = fixture.slot().join("operation.lock");
    fs::rename(&lock, fixture.slot().join("retained.lock")).unwrap();
    assert!(read(&fixture, &binding(), &mut fake).is_err());
    assert!(!lock.exists());
    fs::rename(fixture.slot().join("retained.lock"), &lock).unwrap();
    fs::write(fixture.slot().join("owner.next"), b"incomplete").unwrap();
    assert!(read(&fixture, &binding(), &mut fake).is_err());
    fs::remove_file(fixture.slot().join("owner.next")).unwrap();
    fake.current
        .get_mut(&volume_name(&binding()))
        .unwrap()
        .volume
        .directory
        .inode += 1;
    assert!(read(&fixture, &binding(), &mut fake).is_err());
    fake.current.insert(volume_name(&binding()), observation());
    let mut expected = binding();
    expected.guest.boot_id = "ffffffff-2222-3333-4444-555555555555".into();
    assert!(read(&fixture, &expected, &mut fake).is_err());
    expected = binding();
    expected.scope.owner = "f".repeat(32);
    assert!(read(&fixture, &expected, &mut fake).is_err());
    assert_eq!(
        fs::read(fixture.slot().join("owner.json")).unwrap(),
        original
    );
    assert_eq!(fake.creates, 1);
}

#[test]
fn private_file_rules_lock_exclusion_and_final_cancel_fences_are_real() {
    let fixture = Fixture::new();
    let mut fake = Fake::new();
    enroll_fixture(&fixture, &mut fake);
    let lock = state::Lock::acquire_existing(&fixture.slot()).unwrap();
    assert!(read(&fixture, &binding(), &mut fake).is_err());
    drop(lock);
    let path = fixture.slot().join("owner.json");
    let original = fs::read(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read(&fixture, &binding(), &mut fake).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::hard_link(&path, fixture.slot().join("alias")).unwrap();
    assert!(read(&fixture, &binding(), &mut fake).is_err());
    fs::remove_file(fixture.slot().join("alias")).unwrap();
    fs::rename(&path, fixture.slot().join("original")).unwrap();
    symlink(fixture.slot().join("original"), &path).unwrap();
    assert!(read(&fixture, &binding(), &mut fake).is_err());
    fs::remove_file(&path).unwrap();
    fs::rename(fixture.slot().join("original"), &path).unwrap();
    let cancelled = Rc::new(AtomicBool::new(false));
    let from_probe = cancelled.clone();
    let last = fake.inspects + 1;
    fake.hook = Some(Box::new(move |event| {
        if event == Event::Inspect(last) {
            from_probe.store(true, Ordering::SeqCst);
        }
    }));
    assert!(
        read_retained(
            ReadOptions {
                state_root: &fixture.0,
                binding: &binding(),
                deadline: Instant::now() + Duration::from_secs(10),
                cancelled: &cancelled
            },
            &mut fake
        )
        .is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(fake.creates, 1);
}
