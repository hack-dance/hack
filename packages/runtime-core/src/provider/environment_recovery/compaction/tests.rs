//! Filesystem-only tests. Guest absence is injected through `confirm`; no VM, engine,
//! real HOME or process interruption is involved. Faults stop the state machine in-process.
use super::super::{active_exec_slot_for, graph_slots_for, preflight_records, record_intent};
use super::*;
use std::{
    cell::Cell,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
};

const RUN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_RUN: &str = "cccccccccccccccccccccccccccccccc";
const INCARNATION: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FOREIGN_INCARNATION: &str = "dddddddddddddddddddddddddddddddd";
const PRIOR: &str = "11111111-1111-4111-8111-111111111111";
const CURRENT: &str = "22222222-2222-4222-8222-222222222222";
const SERVICES: usize = 14;

/// Bytes, inode and modification time of each directory entry.
type Snapshot = BTreeMap<String, (Vec<u8>, u64, i64, i64)>;

struct Fixture {
    candidate: Candidate,
    next: Cell<u32>,
}

impl Fixture {
    fn new() -> Self {
        let mut bytes = [0; 16];
        fs::File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut bytes)
            .unwrap();
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hack-env-compaction-{token}"));
        state::private_directory(&path).unwrap();
        let candidate = Candidate::discover(&path).unwrap();
        state::private_directory(&root(&candidate)).unwrap();
        Self {
            candidate,
            next: Cell::new(0),
        }
    }

    fn intent(&self, run: Option<&str>, boot: &str, service: usize) -> Intent {
        let token = self.next.get();
        self.next.set(token + 1);
        Intent {
            version: 1,
            graph: run.map(|run| GraphBinding {
                run: run.into(),
                container: format!("hkg-{run}-container-{service}"),
            }),
            service: format!("svc{service}"),
            uid: 0,
            gid: 0,
            slot: format!("hack-env-lease-{boot}-{token:032x}"),
            incarnation: INCARNATION.into(),
            boot: boot.into(),
        }
    }

    /// One start of every service: a generation of committed records.
    fn generation(&self, run: &str, boot: &str) -> Vec<Intent> {
        (0..SERVICES)
            .map(|service| {
                let intent = self.intent(Some(run), boot, service);
                self.commit(&intent);
                intent
            })
            .collect()
    }

    fn commit(&self, intent: &Intent) {
        state::write(&self.active(&intent.slot), intent).unwrap();
    }

    fn active(&self, slot: &str) -> PathBuf {
        root(&self.candidate).join(format!("{slot}.json"))
    }

    fn tombstone_path(&self, run: &str) -> PathBuf {
        directory(&self.candidate).join(format!("{run}.json"))
    }

    fn compact(
        &self,
        mode: Mode,
        incarnation: &str,
        boot: &str,
        run: &str,
        fault: impl FnMut(Step) -> Result<(), CandidateError>,
    ) -> Result<Compaction, CandidateError> {
        compact_with(
            &self.candidate,
            Request {
                mode,
                incarnation,
                boot,
                run,
                containers: &containers(run),
            },
            |_| Ok(()),
            fault,
        )
    }

    fn compact_now(&self, run: &str) -> Result<Compaction, CandidateError> {
        self.compact(Mode::Compact, INCARNATION, CURRENT, run, |_| Ok(()))
    }

    fn slots(&self, run: &str) -> Result<Vec<String>, CandidateError> {
        Ok(graph_slots_for(&self.candidate, INCARNATION, run)?
            .into_iter()
            .map(|(slot, _, _)| slot)
            .collect())
    }

    /// Bytes plus inode and modification time of every entry, to prove "untouched".
    fn snapshot(&self, directory: &Path) -> Snapshot {
        let Ok(entries) = fs::read_dir(directory) else {
            return BTreeMap::new();
        };
        entries
            .map(|entry| {
                let entry = entry.unwrap();
                let metadata = fs::symlink_metadata(entry.path()).unwrap();
                let bytes = if metadata.file_type().is_symlink() {
                    fs::read_link(entry.path())
                        .unwrap()
                        .into_os_string()
                        .into_encoded_bytes()
                } else {
                    fs::read(entry.path()).unwrap()
                };
                (
                    entry.file_name().into_string().unwrap(),
                    (
                        bytes,
                        metadata.ino(),
                        metadata.mtime(),
                        metadata.mtime_nsec(),
                    ),
                )
            })
            .collect()
    }

    fn state(&self) -> (Snapshot, Snapshot) {
        (
            self.snapshot(&root(&self.candidate)),
            self.snapshot(&directory(&self.candidate)),
        )
    }

    /// Records of another run, a standalone record and a pending record of another run.
    fn foreign(&self) -> Vec<PathBuf> {
        let other = self.intent(Some(OTHER_RUN), CURRENT, 0);
        self.commit(&other);
        let standalone = self.intent(None, CURRENT, 1);
        self.commit(&standalone);
        let uncertain = self.intent(Some(OTHER_RUN), CURRENT, 2);
        let pending = self.active(&uncertain.slot).with_extension("pending");
        write_raw(&pending, &serde_json::to_vec(&uncertain).unwrap());
        vec![
            self.active(&other.slot),
            self.active(&standalone.slot),
            pending,
        ]
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.candidate.checkout).unwrap();
    }
}

fn containers(run: &str) -> BTreeMap<String, String> {
    (0..SERVICES)
        .map(|service| {
            (
                format!("svc{service}"),
                format!("hkg-{run}-container-{service}"),
            )
        })
        .collect()
}

fn write_raw(path: &Path, bytes: &[u8]) {
    std::io::Write::write_all(
        &mut fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap(),
        bytes,
    )
    .unwrap();
}

fn stop_at(target: usize) -> impl FnMut(Step) -> Result<(), CandidateError> {
    let mut seen = 0;
    move |_| {
        seen += 1;
        if seen == target + 1 {
            return Err(CandidateError::new("test_interrupted", "Interrupted."));
        }
        Ok(())
    }
}

#[test]
fn compaction_retains_digests_seals_prior_boots_and_frees_active_budget() {
    let fixture = Fixture::new();
    let mut retired = fixture.generation(RUN, PRIOR);
    retired.extend(fixture.generation(RUN, PRIOR));
    let current = fixture.generation(RUN, CURRENT);
    retired.extend(current.clone());
    let originals: BTreeMap<String, Vec<u8>> = retired
        .iter()
        .map(|intent| {
            (
                intent.slot.clone(),
                fs::read(fixture.active(&intent.slot)).unwrap(),
            )
        })
        .collect();
    let foreign = fixture.foreign();
    let untouched = fixture.snapshot(&root(&fixture.candidate));
    let budget = MAX_INTENT_ENTRIES - foreign.len();
    assert!(preflight_records(&fixture.candidate, budget).is_err());

    let confirmed = Cell::new(0);
    let outcome = compact_with(
        &fixture.candidate,
        Request {
            mode: Mode::Compact,
            incarnation: INCARNATION,
            boot: CURRENT,
            run: RUN,
            containers: &containers(RUN),
        },
        |intent| {
            assert_eq!(intent.graph.as_ref().unwrap().run, RUN);
            confirmed.set(confirmed.get() + 1);
            Ok(())
        },
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(
        outcome,
        Compaction {
            compacted: 3 * SERVICES,
            completed: 0,
            sealed_boots: 1,
        }
    );
    assert_eq!(confirmed.get(), 3 * SERVICES, "every record proven absent");

    let remaining = fixture.snapshot(&root(&fixture.candidate));
    assert_eq!(remaining.len(), foreign.len());
    for (name, entry) in &remaining {
        assert_eq!(untouched.get(name), Some(entry), "foreign record changed");
    }
    assert!(preflight_records(&fixture.candidate, budget).is_ok());

    let tombstone = load(&fixture.candidate, RUN, INCARNATION).unwrap().unwrap();
    assert_eq!(tombstone.sealed.len(), 1);
    assert_eq!(tombstone.sealed[PRIOR].slots, 2 * SERVICES as u32);
    assert_eq!(tombstone.retired.len(), SERVICES);
    for intent in &current {
        assert_eq!(
            tombstone.retired[&intent.slot],
            digest(&originals[&intent.slot])
        );
    }
    for slot in originals.keys() {
        assert!(reserved(&fixture.candidate, RUN, INCARNATION, slot).unwrap());
    }
    assert!(fixture.slots(RUN).unwrap().is_empty());
    assert_eq!(
        fixture.slots(OTHER_RUN).unwrap().len(),
        2,
        "committed and pending"
    );

    // A fresh allocation in the current boot stays admissible.
    let fresh = fixture.intent(Some(RUN), CURRENT, 0);
    assert!(!reserved(&fixture.candidate, RUN, INCARNATION, &fresh.slot).unwrap());
    record_intent(&fixture.candidate, &fresh).unwrap();
    assert_eq!(fixture.slots(RUN).unwrap(), vec![fresh.slot.clone()]);
    fs::remove_file(fixture.active(&fresh.slot)).unwrap();

    let bytes = fs::read(fixture.tombstone_path(RUN)).unwrap();
    assert_eq!(fixture.compact_now(RUN).unwrap(), Compaction::default());
    assert_eq!(
        fs::read(fixture.tombstone_path(RUN)).unwrap(),
        bytes,
        "re-run is idempotent"
    );
}

#[test]
fn interruption_at_each_compaction_step_recovers_without_loss() {
    let build = || {
        let fixture = Fixture::new();
        let mut intents = fixture.generation(RUN, PRIOR);
        intents.extend(fixture.generation(RUN, CURRENT));
        let originals: BTreeMap<String, Vec<u8>> = intents
            .iter()
            .map(|intent| {
                (
                    intent.slot.clone(),
                    fs::read(fixture.active(&intent.slot)).unwrap(),
                )
            })
            .collect();
        let foreign = fixture.foreign();
        let untouched = fixture.snapshot(&root(&fixture.candidate));
        (fixture, originals, foreign, untouched)
    };
    let (reference, _, _, _) = build();
    let steps = Cell::new(0);
    reference
        .compact(Mode::Compact, INCARNATION, CURRENT, RUN, |_| {
            steps.set(steps.get() + 1);
            Ok(())
        })
        .unwrap();
    // Recorded, one unlink per record, directory sync, prior-boot seal.
    assert_eq!(steps.get(), 2 * SERVICES + 3);
    let expected = load(&reference.candidate, RUN, INCARNATION)
        .unwrap()
        .unwrap();

    for target in 0..steps.get() {
        let (fixture, originals, foreign, untouched) = build();
        assert!(
            fixture
                .compact(Mode::Compact, INCARNATION, CURRENT, RUN, stop_at(target))
                .is_err()
        );
        // No loss: every record is still active with its exact bytes, or durably retained.
        let tombstone = load(&fixture.candidate, RUN, INCARNATION).unwrap().unwrap();
        for (slot, bytes) in &originals {
            let active = fixture.active(slot);
            if active.exists() {
                assert_eq!(&fs::read(&active).unwrap(), bytes);
                assert_eq!(tombstone.retired.get(slot), Some(&digest(bytes)));
            } else {
                assert!(
                    reserves(Some(&tombstone), slot),
                    "step {target} lost {slot}"
                );
            }
        }
        // Read-only inventory treats durable residue as retired, never as live.
        assert!(fixture.slots(RUN).unwrap().is_empty(), "step {target}");
        #[cfg(target_os = "macos")]
        assert!(
            graph_inventory(
                &fixture.candidate,
                INCARNATION,
                RUN,
                &containers(RUN),
                &fixture
                    .candidate
                    .state_root
                    .join("graph-environment-archive"),
            )
            .unwrap()
            .is_empty()
        );
        let now = fixture.snapshot(&root(&fixture.candidate));
        for path in &foreign {
            let name = path.file_name().unwrap().to_str().unwrap();
            assert_eq!(untouched.get(name), now.get(name), "step {target} foreign");
        }
        // Alternate recovery entry points: archive's resume-only pass, or the next cleanup.
        if target % 2 == 0 {
            let resumed = fixture
                .compact(Mode::Resume, INCARNATION, CURRENT, RUN, |_| Ok(()))
                .unwrap();
            assert_eq!(resumed.compacted, 0);
            assert_eq!(resumed.sealed_boots, 0);
        }
        fixture.compact_now(RUN).unwrap();
        assert_eq!(
            load(&fixture.candidate, RUN, INCARNATION).unwrap().unwrap(),
            expected,
            "step {target} converges"
        );
        for slot in originals.keys() {
            assert!(!fixture.active(slot).exists());
        }
        assert_eq!(fixture.compact_now(RUN).unwrap(), Compaction::default());
    }
}

#[test]
fn uncommitted_tombstone_write_has_no_authority_and_is_replaced() {
    let fixture = Fixture::new();
    let intents = fixture.generation(RUN, CURRENT);
    let parent = directory(&fixture.candidate);
    state::private_directory(&parent).unwrap();
    let torn = fixture.tombstone_path(RUN).with_extension("pending");
    write_raw(&torn, b"{\"version\":1,\"run\":");
    // Before commit point 1, every record is still live inventory.
    assert_eq!(fixture.slots(RUN).unwrap().len(), SERVICES);
    assert!(!reserved(&fixture.candidate, RUN, INCARNATION, &intents[0].slot).unwrap());
    assert_eq!(fixture.compact_now(RUN).unwrap().compacted, SERVICES);
    assert!(!torn.exists());
    assert!(fixture.slots(RUN).unwrap().is_empty());
    // A temporary that is not a private regular file refuses rather than being removed.
    std::os::unix::fs::symlink("elsewhere", &torn).unwrap();
    fixture.generation(RUN, CURRENT);
    let before = fixture.state();
    assert!(fixture.compact_now(RUN).is_err());
    assert_eq!(fixture.state(), before);
}

#[test]
fn wrong_owner_stale_boot_live_misbound_and_uncertain_records_refuse_without_effects() {
    let fixture = Fixture::new();
    let intents = fixture.generation(RUN, CURRENT);
    fixture.foreign();
    let before = fixture.state();
    let unchanged = |label: &str| assert_eq!(fixture.state(), before, "{label}");

    assert!(
        fixture
            .compact(Mode::Compact, FOREIGN_INCARNATION, CURRENT, RUN, |_| Ok(()))
            .is_err()
    );
    unchanged("wrong owner");
    assert!(!directory(&fixture.candidate).exists());

    let live = intents[3].slot.clone();
    assert!(
        compact_with(
            &fixture.candidate,
            Request {
                mode: Mode::Compact,
                incarnation: INCARNATION,
                boot: CURRENT,
                run: RUN,
                containers: &containers(RUN),
            },
            |intent| if intent.slot == live {
                Err(error())
            } else {
                Ok(())
            },
            |_| Ok(()),
        )
        .is_err()
    );
    unchanged("live slot");

    let mut misbound = containers(RUN);
    misbound.insert("svc5".into(), format!("hkg-{RUN}-container-6"));
    assert!(
        compact_with(
            &fixture.candidate,
            Request {
                mode: Mode::Compact,
                incarnation: INCARNATION,
                boot: CURRENT,
                run: RUN,
                containers: &misbound,
            },
            |_| Ok(()),
            |_| Ok(()),
        )
        .is_err()
    );
    unchanged("misbound container");

    let uncertain = fixture.intent(Some(RUN), CURRENT, 7);
    let pending = fixture.active(&uncertain.slot).with_extension("pending");
    write_raw(&pending, &serde_json::to_vec(&uncertain).unwrap());
    let with_pending = fixture.state();
    assert!(fixture.compact_now(RUN).is_err());
    assert_eq!(fixture.state(), with_pending, "uncertain record");
    // Resume never selects, so it also leaves the uncertain record alone.
    assert_eq!(
        fixture
            .compact(Mode::Resume, INCARNATION, CURRENT, RUN, |_| Ok(()))
            .unwrap(),
        Compaction::default()
    );
    assert_eq!(fixture.state(), with_pending);
    fs::remove_file(&pending).unwrap();

    // Seal CURRENT by compacting from a later boot; the stale boot may not compact again.
    let later = "33333333-3333-4333-8333-333333333333";
    assert_eq!(
        fixture
            .compact(Mode::Compact, INCARNATION, later, RUN, |_| Ok(()))
            .unwrap()
            .sealed_boots,
        1
    );
    let sealed = fixture.state();
    assert!(
        fixture
            .compact(Mode::Compact, INCARNATION, CURRENT, RUN, |_| Ok(()))
            .is_err()
    );
    assert_eq!(fixture.state(), sealed, "stale boot");
}

#[test]
fn replayed_changed_and_copied_state_never_resurrects_a_retired_lease() {
    let fixture = Fixture::new();
    let prior = fixture.generation(RUN, PRIOR);
    let current = fixture.generation(RUN, CURRENT);
    let replay = |intent: &Intent| {
        let path = fixture.active(&intent.slot);
        let bytes = serde_json::to_vec_pretty(intent).unwrap();
        write_raw(&path, &bytes);
        (path, bytes)
    };
    let prior_bytes = fs::read(fixture.active(&prior[0].slot)).unwrap();
    let current_bytes = fs::read(fixture.active(&current[0].slot)).unwrap();
    fixture.compact_now(RUN).unwrap();

    // Exact current-boot replay: retired history, never delivery or a new allocation.
    let (path, bytes) = replay(&current[0]);
    assert_eq!(bytes, current_bytes, "exact copy of the retired record");
    assert!(fixture.slots(RUN).unwrap().is_empty());
    assert!(record_intent(&fixture.candidate, &current[0]).is_err());
    let exec = |slot: &str| {
        active_exec_slot_for(
            &fixture.candidate,
            INCARNATION,
            CURRENT,
            RUN,
            "svc0",
            &format!("hkg-{RUN}-container-0"),
            Some(slot),
        )
    };
    assert!(exec(&current[0].slot).is_err());
    assert_eq!(fixture.compact_now(RUN).unwrap().completed, 1);
    assert!(!path.exists());
    // With no residue left, the retired identity still cannot be recorded again.
    assert!(record_intent(&fixture.candidate, &current[2]).is_err());
    assert!(!fixture.active(&current[2].slot).exists());

    // Stale-boot replay of a sealed boot refuses everywhere and is retained untouched.
    let (path, _) = replay(&prior[0]);
    assert_eq!(fs::read(&path).unwrap(), prior_bytes);
    let before = fixture.state();
    assert!(fixture.slots(RUN).is_err());
    assert!(fixture.compact_now(RUN).is_err());
    assert!(record_intent(&fixture.candidate, &prior[0]).is_err());
    #[cfg(target_os = "macos")]
    assert!(
        graph_inventory(
            &fixture.candidate,
            INCARNATION,
            RUN,
            &containers(RUN),
            &fixture
                .candidate
                .state_root
                .join("graph-environment-archive"),
        )
        .is_err()
    );
    assert_eq!(fixture.state(), before);
    fs::remove_file(&path).unwrap();

    // A changed record under a retired slot identity is refused, never removed, and
    // blocks compaction of an otherwise eligible record before any tombstone write.
    let mut changed = current[1].clone();
    changed.uid = 1000;
    changed.gid = 1000;
    let (path, bytes) = replay(&changed);
    let eligible = fixture.intent(Some(RUN), CURRENT, 4);
    fixture.commit(&eligible);
    let before = fixture.state();
    assert!(fixture.slots(RUN).is_err());
    assert!(fixture.compact_now(RUN).is_err());
    assert!(exec(&changed.slot).is_err());
    assert_eq!(fixture.state(), before);
    assert_eq!(fs::read(&path).unwrap(), bytes);
    fs::remove_file(&path).unwrap();
    assert_eq!(fixture.compact_now(RUN).unwrap().compacted, 1);

    // Copied stores: another run's name, another incarnation, or a linked copy refuse.
    let tombstone = fixture.tombstone_path(RUN);
    let copied = fixture.tombstone_path(OTHER_RUN);
    fs::copy(&tombstone, &copied).unwrap();
    assert!(load(&fixture.candidate, OTHER_RUN, INCARNATION).is_err());
    assert!(fixture.slots(OTHER_RUN).is_err());
    fs::remove_file(&copied).unwrap();
    assert!(load(&fixture.candidate, RUN, FOREIGN_INCARNATION).is_err());
    assert!(graph_slots_for(&fixture.candidate, FOREIGN_INCARNATION, RUN).is_err());
    fs::hard_link(&tombstone, &copied).unwrap();
    assert!(load(&fixture.candidate, RUN, INCARNATION).is_err());
    assert!(fixture.compact_now(RUN).is_err());
    fs::remove_file(&copied).unwrap();
    assert!(
        load(&fixture.candidate, RUN, INCARNATION)
            .unwrap()
            .is_some()
    );
}

#[test]
fn malformed_tombstones_refuse() {
    let fixture = Fixture::new();
    fixture.generation(RUN, PRIOR);
    fixture.compact_now(RUN).unwrap();
    let path = fixture.tombstone_path(RUN);
    let original: serde_json::Value = state::read(&path).unwrap();
    let mut cases = Vec::new();
    let mut overlap = original.clone();
    overlap["retired"][format!("hack-env-lease-{PRIOR}-{}", "f".repeat(32))] =
        serde_json::Value::String("0".repeat(64));
    cases.push(overlap);
    let mut empty_seal = original.clone();
    empty_seal["sealed"][PRIOR]["slots"] = 0.into();
    cases.push(empty_seal);
    let mut unknown = original.clone();
    unknown["values"] = serde_json::json!({"TOKEN": "x"});
    cases.push(unknown);
    let mut version = original;
    version["version"] = 2.into();
    cases.push(version);
    for case in cases {
        fs::remove_file(&path).unwrap();
        state::write(&path, &case).unwrap();
        assert!(load(&fixture.candidate, RUN, INCARNATION).is_err());
        assert!(fixture.compact_now(RUN).is_err());
    }
}

#[test]
fn record_changed_after_tombstone_commit_is_retained_not_unlinked() {
    let fixture = Fixture::new();
    let intents = fixture.generation(RUN, CURRENT);
    let target = fixture.active(&intents[0].slot);
    let mut changed = intents[0].clone();
    changed.uid = 1000;
    let replacement = serde_json::to_vec_pretty(&changed).unwrap();
    // An interruption after commit point 1 during which the record is replaced.
    let outcome = fixture.compact(Mode::Compact, INCARNATION, CURRENT, RUN, |step| {
        if step == Step::Recorded {
            fs::remove_file(&target).unwrap();
            write_raw(&target, &replacement);
        }
        Ok(())
    });
    assert!(outcome.is_err());
    assert_eq!(fs::read(&target).unwrap(), replacement);
    assert!(fixture.slots(RUN).is_err());
    assert!(fixture.compact_now(RUN).is_err());
    assert_eq!(fs::read(&target).unwrap(), replacement);
}
