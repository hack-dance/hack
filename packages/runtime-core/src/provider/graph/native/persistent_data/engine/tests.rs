use super::*;
use crate::provider::state;
use std::{
    cell::Cell,
    fs,
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::PathBuf,
    rc::Rc,
    time::Duration,
};

struct Fixture {
    root: PathBuf,
    data: PathBuf,
    lease: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "persistent-adapter-{}-{}",
            std::process::id(),
            nonce().unwrap()
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let data = root.join("data");
        let lease = root.join("guest");
        for path in [&data, &lease] {
            fs::DirBuilder::new().mode(0o700).create(path).unwrap();
        }
        Self { root, data, lease }
    }
    fn binding(&self) -> Binding {
        Binding {
            scope: Scope {
                namespace: "a".repeat(64),
                storage: "database".into(),
                owner: "b".repeat(32),
            },
            guest: GuestIdentity {
                owner: "c".repeat(32),
                boot_id: "11111111-2222-3333-4444-555555555555".into(),
                storage: DiskIdentity {
                    device: 0,
                    inode: 21,
                    bytes: 128,
                    uuid: "11111111-2222-3333-4444-555555555556".into(),
                },
            },
            policy: Policy {
                driver: Local::Local,
                scope: Local::Local,
                options: NoOptions {},
            },
        }
    }
    fn transport(&self, posts: Rc<Cell<usize>>) -> Endpoint<'_> {
        Endpoint {
            root: &self.lease,
            lock: state::Lock::acquire(&self.lease).unwrap(),
            binding: self.binding(),
            observed: None,
            posts,
            replace_lock: false,
            wrong_birth: false,
            pending: &self.data,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
struct Endpoint<'a> {
    root: &'a std::path::Path,
    lock: state::Lock,
    binding: Binding,
    observed: Option<Observation>,
    posts: Rc<Cell<usize>>,
    replace_lock: bool,
    wrong_birth: bool,
    pending: &'a std::path::Path,
}
impl enrollment::sealed::Transport for Endpoint<'_> {}
impl enrollment::Transport for Endpoint<'_> {
    fn verify(&mut self, expected: &Binding, deadline: Instant) -> Result<(), CandidateError> {
        self.lock.verify_path(self.root)?;
        if Instant::now() >= deadline || *expected != self.binding {
            return Err(refused());
        }
        Ok(())
    }
    fn inspect(
        &mut self,
        _name: &str,
        deadline: Instant,
    ) -> Result<Option<Observation>, CandidateError> {
        enrollment::Transport::verify(self, &self.binding.clone(), deadline)?;
        Ok(self.observed.clone())
    }
    fn create_new(
        &mut self,
        request: &enrollment::CreateRequest,
        deadline: Instant,
    ) -> Result<Observation, CandidateError> {
        create_original(self, request, deadline)
    }
}
impl Creation for Endpoint<'_> {
    fn fence(&mut self, binding: &Binding, deadline: Instant) -> Result<(), CandidateError> {
        enrollment::Transport::verify(self, binding, deadline)
    }
    fn find(
        &mut self,
        name: &str,
        deadline: Instant,
    ) -> Result<Option<Observation>, CandidateError> {
        enrollment::Transport::inspect(self, name, deadline)
    }
    fn post(
        &mut self,
        request: &enrollment::CreateRequest,
        deadline: Instant,
    ) -> Result<Observation, CandidateError> {
        self.fence(request.binding(), deadline)?;
        let entries = fs::read_dir(self.pending)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let bytes = fs::read(entries[0].path().join("owner.json")).unwrap();
        assert!(matches!(
            decode(&bytes).unwrap().0.enrollment,
            Enrollment::Pending { .. }
        ));
        self.posts.set(self.posts.get() + 1);
        // Endpoint deliberately has Docker's idempotent behavior; creation authority
        // must come from the still-held common lock, never this successful response.
        let observed = self
            .observed
            .get_or_insert_with(|| Observation {
                binding: request.binding().clone(),
                volume: VolumeIdentity {
                    name: request.name().into(),
                    created_at: "2026-10-08T00:00:01Z".into(),
                    directory: DirectoryIdentity {
                        device: 0,
                        inode: 42,
                    },
                },
            })
            .clone();
        if self.replace_lock {
            fs::rename(
                self.root.join("operation.lock"),
                self.root.join("former.lock"),
            )
            .unwrap();
            drop(state::Lock::acquire(self.root).unwrap());
        }
        if self.wrong_birth {
            self.observed.as_mut().unwrap().volume.directory.inode += 1;
        }
        Ok(observed)
    }
}
fn enroll(fixture: &Fixture, endpoint: &mut Endpoint<'_>) -> Result<Owner, CandidateError> {
    enrollment::enroll_new(
        enrollment::EnrollOptions {
            state_root: &fixture.data,
            binding: &fixture.binding(),
            intent: &"d".repeat(32),
            deadline: Instant::now() + Duration::from_secs(5),
            cancelled: &AtomicBool::new(false),
        },
        endpoint,
    )
}
#[test]
fn common_original_lock_excludes_second_creator_and_data_has_no_run_binding() {
    let fixture = Fixture::new();
    let posts = Rc::new(Cell::new(0));
    let mut first = fixture.transport(posts.clone());
    assert!(
        matches!(state::Lock::acquire(&fixture.lease), Err(error) if error.code == "provider_busy")
    );
    let owner = enroll(&fixture, &mut first).unwrap();
    assert_eq!(posts.get(), 1);
    for _generation in ["e".repeat(32), "f".repeat(32)] {
        enrollment::read_retained(
            enrollment::ReadOptions {
                state_root: &fixture.data,
                binding: &fixture.binding(),
                deadline: Instant::now() + Duration::from_secs(5),
                cancelled: &AtomicBool::new(false),
            },
            &mut first,
        )
        .unwrap();
        compare(CompareOptions {
            record: &owner,
            expected: &fixture.binding(),
            observed: first.observed.as_ref(),
        })
        .unwrap();
    }
    assert_eq!(posts.get(), 1);
    let lock = fs::symlink_metadata(fixture.lease.join("operation.lock")).unwrap();
    assert_eq!((lock.dev(), lock.ino()), first.lock.identity().unwrap());
}
#[test]
fn idempotent_row_after_lease_loss_or_changed_birth_never_promotes_or_replays() {
    for changed_birth in [false, true] {
        let fixture = Fixture::new();
        let posts = Rc::new(Cell::new(0));
        let mut endpoint = fixture.transport(posts.clone());
        endpoint.replace_lock = !changed_birth;
        endpoint.wrong_birth = changed_birth;
        assert!(enroll(&fixture, &mut endpoint).is_err());
        assert_eq!(posts.get(), 1);
        let slot = fs::read_dir(&fixture.data)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let record = fs::read(slot.join("owner.json")).unwrap();
        assert!(matches!(
            decode(&record).unwrap().0.enrollment,
            Enrollment::Pending { .. }
        ));
        endpoint.replace_lock = false;
        endpoint.wrong_birth = false;
        assert!(enroll(&fixture, &mut endpoint).is_err());
        assert_eq!(posts.get(), 1);
        assert_eq!(fs::read(slot.join("owner.json")).unwrap(), record);
        assert!(endpoint.observed.is_some());
    }
}
