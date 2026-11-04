//! The inspect -> quarantine -> resume/resolve orchestration, exercised as
//! shipped against a synthetic provider. Engine answers are held in memory;
//! the production guest scripts run on a fixture volume. Volume inspection
//! derives `CreatedAt` from the volume directory's mtime, as Docker's `local`
//! driver does, so creating `hack-quarantine` changes it exactly as on a host.
use super::*;
use std::cell::{Cell, RefCell};
use std::time::{Duration, UNIX_EPOCH};

/// A provider change applied after the named guest call.
enum Change {
    /// Replace the in-memory volume inspection.
    Inspect(Value),
    /// Remove and recreate the volume under the same name and labels, as
    /// `docker volume rm` followed by `docker volume create` would.
    Replace,
    InspectFailure,
    IdentityFailure,
}

/// Where a guest effect is interrupted relative to the MOVE script.
#[derive(Clone, Copy, PartialEq)]
enum Fault {
    None,
    /// The host loses the guest before the script runs.
    Before,
    /// The script completes, but its reply is lost.
    After,
}

/// A real graph receipt under the candidate state root, engine answers held in
/// memory, and guest scripts run against a fixture whose
/// `/var/lib/docker/volumes` prefix maps into the fixture directory.
struct Provider {
    fixture: crate::provider::graph::tests::Fixture,
    candidate: Candidate,
    volumes: PathBuf,
    name: String,
    /// Volume inspection without `CreatedAt`, which is derived from the volume
    /// directory unless this value sets it explicitly. Null means absent.
    inspected: RefCell<Value>,
    /// Provider change applied after the named guest call.
    after: RefCell<Option<(&'static str, Change)>>,
    containers: RefCell<Value>,
    observe_reply: RefCell<Option<String>>,
    fault: Cell<Fault>,
    move_reply: RefCell<Option<String>>,
    calls: RefCell<Vec<&'static str>>,
    inspect_failure: Cell<bool>,
    identity_failure: Cell<bool>,
}
impl Provider {
    fn new() -> Self {
        let fixture = crate::provider::graph::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let name = format!("hkg-{RUN}-volume-0");
        let volumes = fixture.0.join("volumes");
        let root = volumes.join(&name).join("_data");
        fs::create_dir_all(root.join(PATH).join("sst")).unwrap();
        fs::write(root.join(PATH).join("sst/00001.sst"), vec![7; 1000]).unwrap();
        fs::write(root.join(PATH).join("CURRENT"), b"corrupt-checksum").unwrap();
        fs::write(root.join("dev/cache/marker"), b"persistent").unwrap();
        fs::write(root.join("BUILD_ID"), b"keep").unwrap();
        let redis = volumes.join(format!("hkg-{RUN}-volume-1/_data"));
        fs::create_dir_all(&redis).unwrap();
        fs::write(redis.join("dump.rdb"), b"redis").unwrap();
        // A volume created well before the operation, so any later entry
        // change in its directory is visible at Docker's one-second precision.
        fs::File::open(volumes.join(&name))
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_secs(1_760_000_000))
            .unwrap();
        let provider = Self {
            candidate,
            inspected: RefCell::new(json!({
                "Name":name,"Driver":"local",
                "Mountpoint":format!("/var/lib/docker/volumes/{name}/_data"),
                "Labels":{"dev.hack.owner":"owner"},"Options":null,"Scope":"local"
            })),
            name,
            volumes,
            fixture,
            after: RefCell::new(None),
            containers: RefCell::new(json!([
                {"State":"running","Mounts":[{"Type":"volume","Name":"unrelated"}]}
            ])),
            observe_reply: RefCell::new(None),
            fault: Cell::new(Fault::None),
            move_reply: RefCell::new(None),
            calls: RefCell::new(Vec::new()),
            inspect_failure: Cell::new(false),
            identity_failure: Cell::new(false),
        };
        provider.receipt("stopped-data-retained", "created");
        let (receipt, _) = provider.load(&provider.candidate, RUN).unwrap();
        provider.inspected.borrow_mut()["Labels"] =
            expected_labels(&receipt, &receipt.resources["volume:www_next"]);
        provider
    }
    /// Write the graph receipt. `redis` varies the receipt bytes the way a
    /// retaining restart rewrites them, without changing the cache volume.
    fn receipt(&self, phase: &str, redis: &str) {
        let root = directory(&self.candidate, RUN).unwrap();
        state::private_directory(&root).unwrap();
        let volume = |key: &str, index: u8, phase: &str, caches: &[&str]| {
            json!({"kind":"volume","key":key,"name":format!("hkg-{RUN}-volume-{index}"),
                "id":null,"image":null,"phase":phase,"disposable_caches":caches})
        };
        state::write(
            &root.join("state.json"),
            &json!({
                "version":1,"run":RUN,"owner":"owner","namespace":"a".repeat(64),
                "plan_id":"b".repeat(64),"phase":phase,"readiness":{},
                "resources":{
                    "volume:www_next":volume("www_next", 0, "created", &[PATH, IMAGES]),
                    "volume:redis":volume("redis", 1, redis, &[])
                }
            }),
        )
        .unwrap();
    }
    fn root(&self) -> PathBuf {
        self.volumes.join(&self.name).join("_data")
    }
    /// Docker `CreatedAt` of the local driver: the volume directory's mtime
    /// at one-second precision.
    fn created_at(&self) -> String {
        let modified = fs::metadata(self.volumes.join(&self.name))
            .unwrap()
            .modified()
            .unwrap();
        let seconds = modified.duration_since(UNIX_EPOCH).unwrap().as_secs();
        format!("unix:{seconds}")
    }
    fn replaced(&self) -> PathBuf {
        self.volumes.join(format!("{}.removed", self.name))
    }
    /// Remove and recreate the volume: a new directory and `_data` identity
    /// under the same name, driver, mountpoint and labels.
    fn replace_volume(&self) {
        fs::rename(self.volumes.join(&self.name), self.replaced()).unwrap();
        fs::create_dir_all(self.root()).unwrap();
    }
    /// Undo `replace_volume`: the original incarnation is back.
    fn restore_volume(&self) {
        fs::remove_dir_all(self.volumes.join(&self.name)).unwrap();
        fs::rename(self.replaced(), self.volumes.join(&self.name)).unwrap();
    }
    fn destination(&self, sha: &str) -> PathBuf {
        self.volumes
            .join(&self.name)
            .join("hack-quarantine")
            .join(&sha[..32])
    }
    fn inspect_path(&self, path: &str) -> Result<Value, CandidateError> {
        inspect_with(&self.candidate, self, &target("www_next", path))
    }
    fn inspect(&self) -> Result<Value, CandidateError> {
        self.inspect_path(PATH)
    }
    fn quarantine(&self, sha: &str) -> Result<Value, CandidateError> {
        quarantine_with(&self.candidate, self, &target("www_next", PATH), sha)
    }
    fn resolve_path(&self, path: &str, sha: &str) -> Result<Value, CandidateError> {
        resolve_with(&self.candidate, self, &target("www_next", path), sha)
    }
    fn resolve(&self, sha: &str) -> Result<Value, CandidateError> {
        self.resolve_path(PATH, sha)
    }
    fn records(&self) -> Vec<Record> {
        Records::load(&self.candidate).unwrap().records
    }
    fn guest_calls(&self) -> Vec<&'static str> {
        self.calls
            .borrow()
            .iter()
            .copied()
            .filter(|c| ["observe", "move", "locate"].contains(c))
            .collect()
    }
    fn untouched_application_data(&self) {
        assert_eq!(
            fs::read(self.root().join("dev/cache/marker")).unwrap(),
            b"persistent"
        );
        assert_eq!(fs::read(self.root().join("BUILD_ID")).unwrap(), b"keep");
        assert_eq!(
            fs::read(
                self.volumes
                    .join(format!("hkg-{RUN}-volume-1/_data/dump.rdb"))
            )
            .unwrap(),
            b"redis"
        );
    }
}
const IMAGES: &str = "dev/cache/images";

impl Port for Provider {
    fn load(&self, candidate: &Candidate, run: &str) -> Result<(Receipt, PathBuf), CandidateError> {
        self.calls.borrow_mut().push("load");
        load_at(directory(candidate, run)?, run, "owner")
    }
    fn inspect(
        &self,
        receipt: &Receipt,
        resource: &Resource,
    ) -> Result<Option<Value>, CandidateError> {
        self.calls.borrow_mut().push("inspect");
        assert_eq!(resource.name, self.name);
        if self.inspect_failure.get() {
            return Err(CandidateError::new(
                "inspect_failed",
                "Synthetic inspect failed.",
            ));
        }
        let mut value = self.inspected.borrow().clone();
        if value.is_null() {
            return Ok(None);
        }
        if value.get("CreatedAt").is_none() {
            value["CreatedAt"] = json!(self.created_at());
        }
        // Use the same identity validator as the production engine adapter,
        // including its distinct observed-foreign/changed identity errors.
        verify_resource_identity(receipt, resource, &value)?;
        Ok(Some(value))
    }
    fn containers(&self) -> Result<Value, CandidateError> {
        self.calls.borrow_mut().push("containers");
        Ok(self.containers.borrow().clone())
    }
    fn execute(&self, program: &str, arguments: &[&str]) -> Result<String, CandidateError> {
        let lost = || CandidateError::new("guest_lost", "Synthetic guest reply was lost.");
        let call = match program {
            OBSERVE => "observe",
            MOVE => "move",
            LOCATE => "locate",
            _ => "identity",
        };
        self.calls.borrow_mut().push(call);
        if call == "identity" && self.identity_failure.get() {
            return Err(lost());
        }
        if call == "observe"
            && let Some(reply) = self.observe_reply.borrow().clone()
        {
            return Ok(reply);
        }
        if call == "move" && self.fault.get() == Fault::Before {
            return Err(lost());
        }
        let prefix = format!("{}/", self.volumes.display());
        let mapped: Vec<String> = arguments
            .iter()
            .map(|a| a.replacen("/var/lib/docker/volumes/", &prefix, 1))
            .collect();
        let mapped: Vec<&str> = mapped.iter().map(String::as_str).collect();
        let output = script(&self.fixture.0, program, &mapped);
        if !output.status.success() {
            return Err(CandidateError::new(
                "guest_script",
                "Synthetic guest script refused.",
            ));
        }
        let changed = self.after.borrow_mut().take_if(|(after, _)| *after == call);
        match changed {
            Some((_, Change::Inspect(changed))) => *self.inspected.borrow_mut() = changed,
            Some((_, Change::Replace)) => self.replace_volume(),
            Some((_, Change::InspectFailure)) => self.inspect_failure.set(true),
            Some((_, Change::IdentityFailure)) => self.identity_failure.set(true),
            None => {}
        }
        if call == "move" && self.fault.get() == Fault::After {
            return Err(lost());
        }
        if call == "move"
            && let Some(reply) = self.move_reply.borrow().clone()
        {
            return Ok(reply);
        }
        Ok(String::from_utf8(output.stdout).unwrap())
    }
}
fn selection_sha(value: &Value) -> String {
    value["selection_sha256"].as_str().unwrap().to_owned()
}

#[test]
fn inspect_then_quarantine_retains_exact_bytes_and_a_regenerated_cache_is_reselected() {
    let provider = Provider::new();
    let inspected = provider.inspect().unwrap();
    assert_eq!(inspected["phase"], "selectable");
    assert_eq!(inspected["mutation"], false);
    assert_eq!(inspected["target_bytes"], 1016);
    assert_eq!(inspected["entries"], 4);
    assert_eq!(inspected["quarantined_bytes"], 0);
    assert_eq!(inspected["retained_quarantine_bytes"], 0);
    assert_eq!(provider.guest_calls(), ["observe"]);
    assert!(
        !provider
            .candidate
            .state_root
            .join("run/cache-quarantine")
            .exists()
    );
    let sha = selection_sha(&inspected);
    let identity_before = identity(&provider.root().join(PATH));

    // A digest that was not reviewed is refused before any guest effect.
    assert!(provider.quarantine(&"0".repeat(64)).is_err());
    assert!(!provider.guest_calls().contains(&"move"));
    assert!(provider.records().is_empty());

    let done = provider.quarantine(&sha).unwrap();
    assert_eq!(done["phase"], "quarantined");
    assert_eq!(done["selection_sha256"], sha);
    assert_eq!(done["mutation"], true);
    assert_eq!(done["moved_now"], true);
    assert_eq!(done["resumed"], false);
    assert_eq!(done["quarantined_bytes"], 1016);
    assert_eq!(done["retained_quarantine_records"], 1);
    assert_eq!(done["retained_quarantine_bytes"], 1016);
    assert_eq!(done["reclaimed_bytes"], 0);
    assert_eq!(done["data_retained"], true);
    assert!(!provider.root().join(PATH).exists());
    let destination = provider.destination(&sha);
    assert_eq!(identity(&destination), identity_before);
    assert_eq!(
        fs::read(destination.join("CURRENT")).unwrap(),
        b"corrupt-checksum"
    );
    provider.untouched_application_data();
    let records = provider.records();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].outcome, Outcome::Quarantined);

    // A retaining restart regenerates the cache: it is a new selection, and
    // the earlier quarantine stays counted for this volume incarnation.
    fs::create_dir(provider.root().join(PATH)).unwrap();
    fs::write(provider.root().join(PATH).join("fresh"), b"ok").unwrap();
    let again = provider.inspect().unwrap();
    assert_eq!(again["phase"], "selectable");
    assert_ne!(selection_sha(&again), sha);
    assert_eq!(again["retained_quarantine_records"], 1);
    assert_eq!(again["retained_quarantine_bytes"], 1016);
    // The old digest no longer describes the source and moves nothing.
    assert!(provider.quarantine(&sha).is_err());
    assert_eq!(
        fs::read(provider.root().join(PATH).join("fresh")).unwrap(),
        b"ok"
    );

    // An already retained directory can never be replayed. Its digest differs
    // now that the quarantine root changed `CreatedAt`; its identity does not.
    fs::remove_dir_all(provider.root().join(PATH)).unwrap();
    fs::rename(&destination, provider.root().join(PATH)).unwrap();
    let replay = selection_sha(&provider.inspect().unwrap());
    assert_ne!(replay, sha);
    provider.calls.borrow_mut().clear();
    assert!(provider.quarantine(&replay).is_err());
    assert!(provider.quarantine(&sha).is_err());
    assert!(!provider.guest_calls().contains(&"move"));
    assert_eq!(provider.records().len(), 1);
    assert_eq!(identity(&provider.root().join(PATH)), identity_before);
    assert!(!destination.exists());
}

#[test]
fn consumers_journal_and_volume_identity_refuse_before_any_guest_observation() {
    let provider = Provider::new();
    let sha = selection_sha(&provider.inspect().unwrap());
    // Any container, stopped or running, that mounts the volume.
    for state in ["exited", "running"] {
        *provider.containers.borrow_mut() = json!([
            {"State":state,"Mounts":[{"Type":"volume","Name":provider.name}]}
        ]);
        provider.calls.borrow_mut().clear();
        assert!(provider.inspect().is_err());
        assert!(provider.quarantine(&sha).is_err());
        assert!(provider.resolve(&sha).is_err());
        assert!(provider.guest_calls().is_empty(), "{state}");
    }
    *provider.containers.borrow_mut() = json!([]);

    // An incomplete graph journal.
    let journal = directory(&provider.candidate, RUN)
        .unwrap()
        .join("state.pending");
    fs::write(&journal, b"").unwrap();
    provider.calls.borrow_mut().clear();
    assert!(provider.inspect().is_err());
    assert!(provider.quarantine(&sha).is_err());
    assert_eq!(*provider.calls.borrow(), ["load", "load"]);
    fs::remove_file(&journal).unwrap();

    // An active graph.
    provider.receipt("ready-observed", "created");
    assert!(provider.inspect().is_err());
    provider.receipt("stopped-data-retained", "created");

    // A missing or differently identified volume.
    let good = provider.inspected.borrow().clone();
    for (field, value) in [
        ("Driver", json!("other")),
        ("Name", json!("hkg-foreign")),
        (
            "Mountpoint",
            json!("/var/lib/docker/volumes/hkg-foreign/_data"),
        ),
        ("CreatedAt", json!("")),
    ] {
        let mut changed = good.clone();
        changed[field] = value;
        *provider.inspected.borrow_mut() = changed;
        provider.calls.borrow_mut().clear();
        assert!(provider.inspect().is_err(), "{field}");
        assert!(provider.quarantine(&sha).is_err(), "{field}");
        assert!(provider.guest_calls().is_empty(), "{field}");
    }
    *provider.inspected.borrow_mut() = Value::Null;
    assert!(provider.inspect().is_err());
    *provider.inspected.borrow_mut() = good;

    // A target reported on another device than the volume root.
    let root_device: u64 = identity(&provider.root())
        .split_once(':')
        .unwrap()
        .0
        .parse()
        .unwrap();
    *provider.observe_reply.borrow_mut() =
        Some(format!("present {}:5 1016 8192 4\n", root_device + 1));
    assert!(provider.inspect().is_err());
    assert!(provider.quarantine(&sha).is_err());
    *provider.observe_reply.borrow_mut() = None;

    assert!(provider.records().is_empty());
    assert!(provider.root().join(PATH).join("CURRENT").exists());
    provider.untouched_application_data();
    // The unchanged reviewed selection is still admitted afterwards.
    assert_eq!(provider.quarantine(&sha).unwrap()["phase"], "quarantined");
}

#[test]
fn interrupted_moves_resume_only_the_recorded_selection() {
    // Lost before the guest rename: resumption moves the recorded source.
    let provider = Provider::new();
    let sha = selection_sha(&provider.inspect().unwrap());
    provider.fault.set(Fault::Before);
    assert!(provider.quarantine(&sha).is_err());
    assert!(provider.root().join(PATH).exists());
    assert_eq!(provider.records()[0].outcome, Outcome::Pending);
    let pending = provider.inspect().unwrap();
    assert_eq!(pending["phase"], "resume_required");
    assert_eq!(selection_sha(&pending), sha);
    provider.fault.set(Fault::None);
    assert!(provider.quarantine(&"0".repeat(64)).is_err());
    let resumed = provider.quarantine(&sha).unwrap();
    assert_eq!(resumed["resumed"], true);
    assert_eq!(resumed["moved_now"], true);
    assert_eq!(provider.records()[0].outcome, Outcome::Quarantined);

    // Lost after the guest rename: resumption adopts the recorded inode.
    let provider = Provider::new();
    let sha = selection_sha(&provider.inspect().unwrap());
    let original = identity(&provider.root().join(PATH));
    provider.fault.set(Fault::After);
    assert!(provider.quarantine(&sha).is_err());
    assert!(!provider.root().join(PATH).exists());
    assert_eq!(provider.inspect().unwrap()["phase"], "resume_required");
    provider.fault.set(Fault::None);
    let resumed = provider.quarantine(&sha).unwrap();
    assert_eq!(resumed["resumed"], true);
    assert_eq!(resumed["moved_now"], false);
    assert_eq!(identity(&provider.destination(&sha)), original);
    provider.untouched_application_data();
}

#[test]
fn a_restart_before_resumption_requires_explicit_resolution_without_moving_bytes() {
    let provider = Provider::new();
    let sha = selection_sha(&provider.inspect().unwrap());
    provider.fault.set(Fault::Before);
    assert!(provider.quarantine(&sha).is_err());
    provider.fault.set(Fault::None);
    // A retaining restart rewrote the receipt before the operator resumed.
    provider.receipt("stopped-data-retained", "absent");
    let pending = provider.inspect().unwrap();
    assert_eq!(pending["phase"], "resolve_required");
    assert_eq!(selection_sha(&pending), sha);
    // Resumption needs the reviewed receipt; nothing is moved.
    assert!(provider.quarantine(&sha).is_err());
    assert!(provider.root().join(PATH).join("CURRENT").exists());
    // Another declared path of the same volume waits for this resolution.
    fs::create_dir(provider.root().join(IMAGES)).unwrap();
    fs::write(provider.root().join(IMAGES).join("a"), b"i").unwrap();
    let other = provider.inspect_path(IMAGES).unwrap();
    assert_eq!(other["phase"], "resolve_required");
    assert_eq!(other["path"], PATH);
    // Resolution needs the recorded digest and path.
    assert!(provider.resolve(&"0".repeat(64)).is_err());
    assert!(provider.resolve_path(IMAGES, &sha).is_err());
    provider.calls.borrow_mut().clear();
    let resolved = provider.resolve(&sha).unwrap();
    assert_eq!(resolved["phase"], "abandoned");
    assert_eq!(resolved["resolved"], true);
    assert_eq!(resolved["mutation"], false);
    assert_eq!(resolved["quarantined_bytes"], 0);
    assert_eq!(provider.guest_calls(), ["locate"]);
    assert!(provider.root().join(PATH).join("CURRENT").exists());
    assert_eq!(provider.records()[0].outcome, Outcome::Abandoned);
    // Nothing is pending; a fresh review of the current receipt proceeds.
    assert!(provider.resolve(&sha).is_err());
    let fresh = provider.inspect().unwrap();
    assert_eq!(fresh["phase"], "selectable");
    assert_ne!(selection_sha(&fresh), sha);
    let done = provider.quarantine(&selection_sha(&fresh)).unwrap();
    assert_eq!(done["phase"], "quarantined");
    assert_eq!(done["retained_quarantine_records"], 1);
    assert_eq!(
        fs::read(provider.root().join(IMAGES).join("a")).unwrap(),
        b"i"
    );
    provider.untouched_application_data();
}

#[test]
fn resolution_records_a_rename_that_completed_before_the_restart() {
    let provider = Provider::new();
    let sha = selection_sha(&provider.inspect().unwrap());
    let original = identity(&provider.root().join(PATH));
    provider.fault.set(Fault::After);
    assert!(provider.quarantine(&sha).is_err());
    provider.fault.set(Fault::None);
    provider.receipt("stopped-data-retained", "absent");
    // The restarted application regenerated its cache at the source.
    fs::create_dir(provider.root().join(PATH)).unwrap();
    fs::write(provider.root().join(PATH).join("fresh"), b"ok").unwrap();
    assert_eq!(provider.inspect().unwrap()["phase"], "resolve_required");
    let resolved = provider.resolve(&sha).unwrap();
    assert_eq!(resolved["phase"], "quarantined");
    assert_eq!(resolved["quarantined_bytes"], 1016);
    assert_eq!(resolved["retained_quarantine_bytes"], 1016);
    assert_eq!(identity(&provider.destination(&sha)), original);
    assert_eq!(
        fs::read(provider.root().join(PATH).join("fresh")).unwrap(),
        b"ok"
    );
    assert_eq!(provider.records()[0].outcome, Outcome::Quarantined);
    // A settled record cannot be resolved again.
    assert!(provider.resolve(&sha).is_err());
}

#[test]
fn a_volume_replaced_during_a_guest_effect_is_never_settled() {
    let provider = Provider::new();
    let sha = selection_sha(&provider.inspect().unwrap());
    // Removed and recreated under the same name, driver, mountpoint and labels.
    *provider.after.borrow_mut() = Some(("move", Change::Replace));
    let error = provider.quarantine(&sha).unwrap_err();
    assert_eq!(error.code, "graph_cache_quarantine_unsettled");
    assert_eq!(provider.records()[0].outcome, Outcome::Pending);
    // The changed incarnation cannot resume the reviewed selection.
    assert_eq!(provider.inspect().unwrap()["phase"], "resolve_required");
    assert!(provider.quarantine(&sha).is_err());
    assert_eq!(provider.records()[0].outcome, Outcome::Pending);
    // Resolution observed under one incarnation is not recorded under another.
    provider.restore_volume();
    *provider.after.borrow_mut() = Some(("locate", Change::Replace));
    assert_eq!(
        provider.resolve(&sha).unwrap_err().code,
        "graph_cache_quarantine_unsettled"
    );
    assert_eq!(provider.records()[0].outcome, Outcome::Pending);
    // Any other inspected change across the effect also refuses settlement.
    provider.restore_volume();
    let mut relabeled = provider.inspected.borrow().clone();
    relabeled["Labels"]["dev.hack.owner"] = json!("other");
    *provider.after.borrow_mut() = Some(("locate", Change::Inspect(relabeled)));
    assert!(provider.resolve(&sha).is_err());
    assert_eq!(provider.records()[0].outcome, Outcome::Pending);
}

/// HACK-1301: Docker reports `CreatedAt` from the volume directory's mtime, and
/// the first quarantine creates `hack-quarantine` in that directory.
#[test]
fn the_first_quarantine_settles_although_creating_its_root_changes_created_at() {
    let provider = Provider::new();
    let before = provider.created_at();
    let sha = selection_sha(&provider.inspect().unwrap());
    let quarantine_root = provider
        .volumes
        .join(&provider.name)
        .join("hack-quarantine");
    assert!(!quarantine_root.exists());
    let done = provider.quarantine(&sha).unwrap();
    assert!(quarantine_root.is_dir());
    assert_ne!(provider.created_at(), before, "fixture models the driver");
    assert_eq!(done["phase"], "quarantined");
    assert_eq!(done["moved_now"], true);
    assert_eq!(done["quarantined_bytes"], 1016);
    assert_eq!(done["retained_quarantine_records"], 1);
    assert_eq!(done["retained_quarantine_bytes"], 1016);
    assert_eq!(provider.records()[0].outcome, Outcome::Quarantined);
    let absent = provider.inspect().unwrap();
    assert_eq!(absent["phase"], "target_absent");
    assert_eq!(absent["retained_quarantine_records"], 1);
    assert_eq!(absent["retained_quarantine_bytes"], 1016);
    provider.untouched_application_data();
}

/// A record left `pending` by the earlier `CreatedAt` recheck (bytes moved,
/// quarantine root created, `volume_created` from before the `mkdir`) resumes
/// or resolves to `quarantined` and counts its retained bytes.
#[test]
fn a_record_stuck_by_the_created_at_recheck_resumes_or_resolves_with_retained_bytes() {
    for resolve in [false, true] {
        let provider = Provider::new();
        let sha = selection_sha(&provider.inspect().unwrap());
        let original = identity(&provider.root().join(PATH));
        // The move completed but settlement did not: the same stored state the
        // earlier recheck refusal left on the host.
        provider.fault.set(Fault::After);
        assert!(provider.quarantine(&sha).is_err());
        provider.fault.set(Fault::None);
        let stuck = provider.records().remove(0);
        assert_eq!(stuck.outcome, Outcome::Pending);
        assert_ne!(stuck.selection.volume_created, provider.created_at());
        assert!(!provider.root().join(PATH).exists());
        let pending = provider.inspect().unwrap();
        assert_eq!(pending["phase"], "resume_required");
        assert_eq!(pending["retained_quarantine_bytes"], 0);
        let settled = if resolve {
            provider.resolve(&sha).unwrap()
        } else {
            let resumed = provider.quarantine(&sha).unwrap();
            assert_eq!(resumed["resumed"], true);
            assert_eq!(resumed["moved_now"], false);
            resumed
        };
        assert_eq!(settled["phase"], "quarantined", "resolve={resolve}");
        assert_eq!(settled["quarantined_bytes"], 1016);
        assert_eq!(settled["retained_quarantine_bytes"], 1016);
        assert_eq!(provider.records()[0].outcome, Outcome::Quarantined);
        assert_eq!(identity(&provider.destination(&sha)), original);
        let absent = provider.inspect().unwrap();
        assert_eq!(absent["phase"], "target_absent");
        assert_eq!(absent["retained_quarantine_bytes"], 1016);
        provider.untouched_application_data();
    }
}

#[test]
fn unexpected_successful_move_replies_leave_pending_records_for_resolution() {
    for reply in [
        "",
        "cache-quarantine-v1 mov",
        "unexpected\n",
        "cache-quarantine-v1 moved\nextra\n",
    ] {
        let provider = Provider::new();
        let sha = selection_sha(&provider.inspect().unwrap());
        let original = identity(&provider.root().join(PATH));
        *provider.move_reply.borrow_mut() = Some(reply.to_owned());
        let error = provider.quarantine(&sha).unwrap_err();
        assert_eq!(error.code, "graph_cache_quarantine_unsettled");
        assert!(error.message.contains("may have moved"));
        assert!(error.message.contains("resume or resolution"));
        assert!(!error.message.contains("no cache bytes were moved"));
        assert_eq!(provider.records()[0].outcome, Outcome::Pending);
        assert!(!provider.root().join(PATH).exists());
        assert_eq!(identity(&provider.destination(&sha)), original);
        assert_eq!(provider.inspect().unwrap()["phase"], "resume_required");
        // The resumed script succeeds too; an unrecognized reply still cannot
        // settle the record or move another directory.
        assert_eq!(
            provider.quarantine(&sha).unwrap_err().code,
            "graph_cache_quarantine_unsettled"
        );
        assert_eq!(provider.records()[0].outcome, Outcome::Pending);
        assert_eq!(identity(&provider.destination(&sha)), original);
        provider.calls.borrow_mut().clear();
        let resolved = provider.resolve(&sha).unwrap();
        assert_eq!(resolved["phase"], "quarantined");
        assert_eq!(resolved["mutation"], false);
        assert_eq!(provider.guest_calls(), ["locate"]);
        assert_eq!(provider.records()[0].outcome, Outcome::Quarantined);
        provider.untouched_application_data();
    }
}

/// Exercise each affected feature's production read-only selection/verification
/// through the synthetic provider, after running the real quarantine script.
/// This does not qualify the native provider transport or host recovery gate.
#[test]
fn retained_volume_features_accept_quarantine_but_refuse_replacement() {
    use crate::provider::graph::{restore, volume_identity};
    let provider = Provider::new();
    let (mut receipt, _) = provider.load(&provider.candidate, RUN).unwrap();
    receipt.resources.remove("volume:redis");
    let resource = &receipt.resources["volume:www_next"];
    let observe = |resource: &Resource| {
        volume_identity::observe_with(
            resource,
            || Port::inspect(&provider, &receipt, resource),
            |program, args| provider.execute(program, args),
        )
    };
    let before_inspect = Port::inspect(&provider, &receipt, resource)
        .unwrap()
        .unwrap();
    let selected = volume_identity::select_with(&receipt, observe).unwrap();
    let restore_selected = restore::observed_volumes_with(&receipt, observe).unwrap();
    let saved = serde_json::to_vec(&selected).unwrap();
    let selected: BTreeMap<String, Value> = serde_json::from_slice(&saved).unwrap();
    let sha = selection_sha(&provider.inspect().unwrap());
    provider.quarantine(&sha).unwrap();
    let after_inspect = Port::inspect(&provider, &receipt, resource)
        .unwrap()
        .unwrap();
    assert_ne!(before_inspect["CreatedAt"], after_inspect["CreatedAt"]);
    let after = observe(resource).unwrap();
    volume_identity::verify_with(&receipt, &selected, observe).unwrap();
    assert_eq!(
        volume_identity::select_with(&receipt, observe).unwrap(),
        selected
    );
    // Restore generation, source-device rebind and quiescent-dependency recovery
    // all persist and compare this same production selection.
    assert_eq!(
        restore::observed_volumes_with(&receipt, observe).unwrap(),
        restore_selected
    );
    assert!(volume_identity::retained_matches(
        selected.get("volume:www_next"),
        Some(&after),
        true
    ));
    volume_subpaths::check_after_quarantine(
        &before_inspect,
        &after_inspect,
        after["directory"].as_str().unwrap(),
        |program, args| provider.execute(program, args),
    );
    for change in [
        Change::Replace,
        Change::Inspect({
            let mut changed = provider.inspected.borrow().clone();
            changed["Options"] = json!({"type":"tmpfs"});
            changed
        }),
    ] {
        match change {
            Change::Replace => provider.replace_volume(),
            Change::Inspect(value) => *provider.inspected.borrow_mut() = value,
            _ => unreachable!(),
        }
        let replacement = observe(resource).unwrap();
        assert!(volume_identity::verify_with(&receipt, &selected, observe).is_err());
        assert_ne!(
            volume_identity::select_with(&receipt, observe).unwrap(),
            selected
        );
        assert_ne!(
            restore::observed_volumes_with(&receipt, observe).unwrap(),
            restore_selected
        );
        assert!(!volume_identity::retained_matches(
            selected.get("volume:www_next"),
            Some(&replacement),
            true
        ));
        if provider.replaced().exists() {
            provider.restore_volume();
        }
    }
}

#[test]
fn failed_post_effect_observations_do_not_claim_the_volume_changed() {
    for effect in ["move", "locate"] {
        for change in [Change::InspectFailure, Change::IdentityFailure] {
            let provider = Provider::new();
            let sha = selection_sha(&provider.inspect().unwrap());
            if effect == "locate" {
                provider.fault.set(Fault::After);
                assert!(provider.quarantine(&sha).is_err());
                provider.fault.set(Fault::None);
            }
            *provider.after.borrow_mut() = Some((effect, change));
            let result = if effect == "move" {
                provider.quarantine(&sha)
            } else {
                provider.resolve(&sha)
            };
            let error = result.unwrap_err();
            assert_eq!(error.code, "graph_cache_quarantine_unobserved");
            assert!(error.message.contains("could not be observed"));
            assert!(!error.message.contains("volume changed"));
            assert_eq!(provider.records()[0].outcome, Outcome::Pending);
            provider.inspect_failure.set(false);
            provider.identity_failure.set(false);
            provider.resolve(&sha).unwrap();
            assert_eq!(provider.records()[0].outcome, Outcome::Quarantined);
        }
    }
}

#[test]
fn production_inspection_identity_errors_remain_observed_changes_after_effects() {
    for effect in ["move", "locate"] {
        for (field, value, validation_code) in [
            (
                "Labels",
                json!({"io.hack-local.owner":"foreign"}),
                Some("graph_foreign_resource"),
            ),
            ("Name", json!("foreign"), Some("graph_resource_identity")),
            ("Driver", json!("foreign"), Some("graph_resource_identity")),
            (
                "Mountpoint",
                json!("/var/lib/docker/volumes/foreign/_data"),
                None,
            ),
            ("Options", json!({"type":"tmpfs"}), None),
            ("Scope", json!("foreign"), None),
        ] {
            let provider = Provider::new();
            let sha = selection_sha(&provider.inspect().unwrap());
            if effect == "locate" {
                provider.fault.set(Fault::After);
                assert!(provider.quarantine(&sha).is_err());
                provider.fault.set(Fault::None);
            }
            let original = provider.inspected.borrow().clone();
            let mut changed = original.clone();
            changed[field] = value;
            let (receipt, _) = provider.load(&provider.candidate, RUN).unwrap();
            let validation =
                verify_resource_identity(&receipt, &receipt.resources["volume:www_next"], &changed);
            assert_eq!(
                validation.err().map(|failure| failure.code),
                validation_code
            );
            *provider.after.borrow_mut() = Some((effect, Change::Inspect(changed)));
            let result = if effect == "move" {
                provider.quarantine(&sha)
            } else {
                provider.resolve(&sha)
            };
            let failure = result.unwrap_err();
            assert_eq!(
                failure.code, "graph_cache_quarantine_unsettled",
                "{effect}:{field}"
            );
            assert!(failure.message.contains("volume changed"));
            // No IDENTITY call may mask already observed metadata drift.
            assert_eq!(provider.calls.borrow().last(), Some(&"inspect"));
            assert_eq!(provider.records()[0].outcome, Outcome::Pending);
            *provider.inspected.borrow_mut() = original;
            provider.resolve(&sha).unwrap();
            assert_eq!(provider.records()[0].outcome, Outcome::Quarantined);
        }
    }
}
