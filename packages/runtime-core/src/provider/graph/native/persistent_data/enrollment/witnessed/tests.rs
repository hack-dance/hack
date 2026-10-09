use super::super::super::{DirectoryIdentity, VolumeIdentity};
use super::*;
use serde_json::{Value, json};
use std::{
    os::unix::fs::PermissionsExt,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "witness-enroll-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }
    fn record(&self) -> Value {
        serde_json::from_slice(
            &fs::read(self.0.join(slot_name(&binding())).join("owner.json")).unwrap(),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn binding() -> Binding {
    serde_json::from_value(json!({"scope":{"namespace":"a".repeat(64),"storage":"db","owner":"b".repeat(32)},"guest":{"owner":"c".repeat(32),"boot_id":"11111111-2222-3333-4444-555555555555","storage":{"device":0,"inode":25,"bytes":8192,"uuid":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}},"policy":{"driver":"local","scope":"local","options":{}}})).unwrap()
}
fn witness() -> ExpectedWitness {
    ExpectedWitness {
        name: format!("user.hack.storage.{}", "d".repeat(64)),
        value: "e".repeat(64),
    }
}
fn root() -> RootIdentity {
    RootIdentity {
        device: 0,
        inode: 91,
        uid: 0,
        gid: 0,
    }
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
struct Fake {
    state_root: PathBuf,
    current: Option<Observation>,
    created: usize,
    seeds: usize,
    reads: usize,
    witness_present: bool,
    seed_error: bool,
    replace_record: bool,
    changed_root: bool,
    postgres_owner: bool,
}
impl Fake {
    fn new(f: &Fixture) -> Self {
        Self {
            state_root: f.0.clone(),
            current: None,
            created: 0,
            seeds: 0,
            reads: 0,
            witness_present: false,
            seed_error: false,
            replace_record: false,
            changed_root: false,
            postgres_owner: false,
        }
    }
}
impl super::super::sealed::Transport for Fake {}
impl super::super::Transport for Fake {
    fn verify(&mut self, expected: &Binding, _: Instant) -> Result<(), CandidateError> {
        if expected != &binding() {
            return Err(refused());
        }
        Ok(())
    }
    fn inspect(&mut self, _: &str, _: Instant) -> Result<Option<Observation>, CandidateError> {
        Ok(self.current.clone())
    }
    fn create_new(
        &mut self,
        request: &CreateRequest,
        _: Instant,
    ) -> Result<Observation, CandidateError> {
        let bytes = fs::read(
            self.state_root
                .join(slot_name(&binding()))
                .join("owner.json"),
        )
        .unwrap();
        let owner = witnessed::decode(&bytes).unwrap();
        let witnessed::Enrollment::Pending {
            intent,
            volume_name,
            witness: expected,
        } = &owner.0.enrollment
        else {
            panic!("missing durable pending witness");
        };
        assert_eq!(intent, request.intent());
        assert_eq!(volume_name, request.name());
        assert!(expected == &witness());
        assert!(self.current.is_none());
        self.created += 1;
        self.current = Some(observation());
        Ok(observation())
    }
}
impl Transport for Fake {
    fn root(&mut self, _: &Observation, _: Instant) -> Result<RootIdentity, CandidateError> {
        let mut r = root();
        if self.changed_root {
            r.uid = 1;
        }
        if self.postgres_owner {
            r.uid = 70;
            r.gid = 70;
        }
        Ok(r)
    }
    fn seed(&mut self, request: &SeedRequest, _: Instant) -> Result<(), CandidateError> {
        assert!(request.captured() == &observation());
        assert!(request.witness() == &witness());
        assert!(request.root() == root());
        assert!(!self.witness_present);
        self.seeds += 1;
        self.witness_present = true;
        if self.seed_error {
            return Err(CandidateError::new("private-canary", "private-canary"));
        }
        Ok(())
    }
    fn verify_witness(
        &mut self,
        _: &Observation,
        _: RootIdentity,
        expected: &ExpectedWitness,
        _: Instant,
    ) -> Result<(), CandidateError> {
        self.reads += 1;
        if self.replace_record {
            self.replace_record = false;
            let file = self
                .state_root
                .join(slot_name(&binding()))
                .join("owner.json");
            let bytes = fs::read(&file).unwrap();
            fs::rename(&file, file.with_extension("old")).unwrap();
            fs::write(&file, bytes).unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        }
        if !self.witness_present || expected != &witness() {
            return Err(refused());
        }
        Ok(())
    }
}
fn options<'a>(
    f: &'a Fixture,
    b: &'a Binding,
    w: &'a ExpectedWitness,
    cancelled: &'a AtomicBool,
) -> EnrollOptions<'a> {
    EnrollOptions {
        base: super::super::EnrollOptions {
            state_root: &f.0,
            binding: b,
            intent: "f0000000000000000000000000000000",
            deadline: Instant::now() + Duration::from_secs(5),
            cancelled,
        },
        witness: w,
    }
}
fn read_options<'a>(f: &'a Fixture, b: &'a Binding, c: &'a AtomicBool) -> ReadOptions<'a> {
    ReadOptions {
        state_root: &f.0,
        binding: b,
        deadline: Instant::now() + Duration::from_secs(5),
        cancelled: c,
    }
}

#[test]
fn original_create_and_seed_follow_durable_expected_witness_and_retained_read_never_seeds() {
    let f = Fixture::new();
    let b = binding();
    let w = witness();
    let c = AtomicBool::new(false);
    let mut fake = Fake::new(&f);
    let owner = enroll_new(options(&f, &b, &w, &c), &mut fake).unwrap();
    assert_eq!((fake.created, fake.seeds), (1, 1));
    assert!(fake.reads >= 3);
    let bytes = fs::read(f.0.join(slot_name(&b)).join("owner.json")).unwrap();
    assert_eq!(serde_json::to_vec(&owner).unwrap(), bytes);
    assert!(read_retained(read_options(&f, &b, &c), &mut fake).is_ok());
    assert!(
        existing_binding(BindingSelectionOptions {
            state_root: &f.0,
            namespace: &b.scope.namespace,
            storage: &b.scope.storage
        })
        .unwrap()
        .is_some_and(|selected| selected == b)
    );
    assert_eq!((fake.created, fake.seeds), (1, 1));
    fake.witness_present = false; // identical labels/birth/dev+ino on a replacement cannot pass
    assert!(read_retained(read_options(&f, &b, &c), &mut fake).is_err());
    assert_eq!((fake.created, fake.seeds), (1, 1));
    fake.witness_present = true;
    fake.changed_root = true;
    assert!(read_retained(read_options(&f, &b, &c), &mut fake).is_err());
    assert_eq!((fake.created, fake.seeds), (1, 1));
}
#[test]
fn ambiguous_seed_keeps_pending_and_never_promotes_or_retries() {
    let f = Fixture::new();
    let b = binding();
    let w = witness();
    let c = AtomicBool::new(false);
    let mut fake = Fake::new(&f);
    fake.seed_error = true;
    let error = enroll_new(options(&f, &b, &w, &c), &mut fake)
        .err()
        .unwrap();
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("private-canary")
    );
    assert_eq!(f.record()["enrollment"]["status"], "pending");
    assert!(
        existing_binding(BindingSelectionOptions {
            state_root: &f.0,
            namespace: &b.scope.namespace,
            storage: &b.scope.storage
        })
        .is_err()
    );
    let bytes = fs::read(f.0.join(slot_name(&b)).join("owner.json")).unwrap();
    assert!(read_retained(read_options(&f, &b, &c), &mut fake).is_err());
    assert!(enroll_new(options(&f, &b, &w, &c), &mut fake).is_err());
    assert_eq!((fake.created, fake.seeds), (1, 1));
    assert_eq!(
        fs::read(f.0.join(slot_name(&b)).join("owner.json")).unwrap(),
        bytes
    );
}

#[test]
fn metadata_selection_is_not_a_mount_proof_and_owner_handoff_remains_refused() {
    let f = Fixture::new();
    let b = binding();
    let w = witness();
    let c = AtomicBool::new(false);
    let mut fake = Fake::new(&f);
    enroll_new(options(&f, &b, &w, &c), &mut fake).unwrap();
    let select = || {
        selected_owner(BindingSelectionOptions {
            state_root: &f.0,
            namespace: &b.scope.namespace,
            storage: &b.scope.storage,
        })
    };
    let original = fs::read(f.0.join(slot_name(&b)).join("owner.json")).unwrap();
    fake.witness_present = false;
    assert!(select().unwrap().is_some());
    assert!(read_retained(read_options(&f, &b, &c), &mut fake).is_err());
    fake.witness_present = true;
    fake.postgres_owner = true;
    assert!(select().unwrap().is_some());
    assert!(read_retained(read_options(&f, &b, &c), &mut fake).is_err());
    assert_eq!((fake.created, fake.seeds), (1, 1));
    assert_eq!(
        fs::read(f.0.join(slot_name(&b)).join("owner.json")).unwrap(),
        original
    );
}
#[test]
fn preexisting_metadata_or_record_replacement_cannot_enroll() {
    let b = binding();
    let w = witness();
    let c = AtomicBool::new(false);
    let f = Fixture::new();
    let mut fake = Fake::new(&f);
    fake.current = Some(observation());
    assert!(enroll_new(options(&f, &b, &w, &c), &mut fake).is_err());
    assert_eq!((fake.created, fake.seeds), (0, 0));
    assert!(!f.0.join(slot_name(&b)).exists());
    let f = Fixture::new();
    let mut fake = Fake::new(&f);
    fake.replace_record = true;
    assert!(enroll_new(options(&f, &b, &w, &c), &mut fake).is_err());
    assert_eq!((fake.created, fake.seeds), (1, 1));
    assert_eq!(f.record()["enrollment"]["status"], "pending");
}
#[test]
fn final_directory_sync_failure_is_uncertain_and_cannot_report_enrollment() {
    struct Fail;
    impl Sync for Fail {
        fn sync(&mut self, file: &File, step: Step) -> Result<(), CandidateError> {
            if step == Step::CommittedDirectory {
                return Err(refused());
            }
            file.sync_all().map_err(|_| refused())
        }
    }
    let f = Fixture::new();
    let b = binding();
    let w = witness();
    let c = AtomicBool::new(false);
    let mut fake = Fake::new(&f);
    assert!(enroll(options(&f, &b, &w, &c), &mut fake, &mut Fail).is_err());
    assert_eq!(f.record()["enrollment"]["status"], "enrolled"); // rename may have happened; success/durability was withheld
    assert_eq!((fake.created, fake.seeds), (1, 1));
}
#[test]
fn pending_parent_sync_must_succeed_before_original_create_or_seed() {
    struct Fail;
    impl Sync for Fail {
        fn sync(&mut self, file: &File, step: Step) -> Result<(), CandidateError> {
            if step == Step::PendingDirectory {
                return Err(refused());
            }
            file.sync_all().map_err(|_| refused())
        }
    }
    let f = Fixture::new();
    let b = binding();
    let w = witness();
    let c = AtomicBool::new(false);
    let mut fake = Fake::new(&f);
    assert!(enroll(options(&f, &b, &w, &c), &mut fake, &mut Fail).is_err());
    assert_eq!((fake.created, fake.seeds), (0, 0));
    assert_eq!(f.record()["enrollment"]["status"], "pending");
}
#[test]
fn v1_and_missing_or_forged_witness_fields_cannot_decode_as_v2() {
    let record = witnessed::enrolled(binding(), observation().volume, root(), witness());
    let raw = serde_json::to_value(&record).unwrap();
    for pointer in [
        "/version",
        "/enrollment/witness/name",
        "/enrollment/witness/value",
        "/enrollment/root/inode",
    ] {
        let mut wrong = raw.clone();
        *wrong.pointer_mut(pointer).unwrap() = Value::Null;
        assert!(witnessed::decode(&serde_json::to_vec(&wrong).unwrap()).is_err());
    }
    let mut wrong = raw.clone();
    wrong["version"] = json!(1);
    assert!(witnessed::decode(&serde_json::to_vec(&wrong).unwrap()).is_err());
    let mut wrong = raw.clone();
    wrong["run"] = json!("a".repeat(32));
    assert!(witnessed::decode(&serde_json::to_vec(&wrong).unwrap()).is_err());
    let bytes = serde_json::to_string(&record).unwrap();
    assert!(
        witnessed::decode(
            bytes
                .replacen("\"version\":2", "\"version\":2,\"version\":2", 1)
                .as_bytes()
        )
        .is_err()
    );
    assert!(super::super::super::decode(bytes.as_bytes()).is_err());
}
