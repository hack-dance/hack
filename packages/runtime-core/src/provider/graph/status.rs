//! Lease-free presentation. A stable journal fences a point-in-time observation;
//! it never authorizes an effect or substitutes for locked recovery inspection.
use super::*;
use std::os::unix::fs::MetadataExt;

#[derive(PartialEq, Eq)]
struct Stamp {
    dev: u64,
    ino: u64,
    len: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}

fn stamp(path: &std::path::Path) -> Result<Option<Stamp>, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(value) => Ok(Some(Stamp {
            dev: value.dev(),
            ino: value.ino(),
            len: value.len(),
            modified: (value.mtime(), value.mtime_nsec()),
            changed: (value.ctime(), value.ctime_nsec()),
        })),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(state::io(error)),
    }
}

fn changed() -> CandidateError {
    error(
        "graph_status_changed",
        "The graph changed during status observation; no consistent snapshot was observed.",
    )
}

/// Atomic journal replacement and pending-file publication change the directory
/// stamp, including a pending file created and removed during the observation.
/// Also fence in-place writes to each existing direct journal member. No lock,
/// journal creation, repair or retry of an effect participates in this read.
pub(in crate::provider::graph) fn stable<T>(
    root: &std::path::Path,
    read: impl FnOnce() -> Result<T, CandidateError>,
) -> Result<T, CandidateError> {
    let capture = || -> Result<_, CandidateError> {
        let directory = stamp(root)?;
        let mut members = BTreeMap::new();
        if directory.is_some() {
            for entry in fs::read_dir(root).map_err(state::io)? {
                let entry = entry.map_err(state::io)?;
                if members.len() >= 1024 {
                    return Err(changed());
                }
                members.insert(entry.file_name(), stamp(&entry.path())?);
            }
        }
        Ok((directory, members))
    };
    let before = capture()?;
    let result = read();
    if capture()? != before {
        return Err(changed());
    }
    result
}

#[cfg(target_os = "macos")]
pub fn inspect(candidate: &Candidate, run: &str) -> Result<Snapshot, CandidateError> {
    let observer = super::super::engine::Observer::connect(candidate)?;
    inspect_with(candidate, run, &observer)
}

fn inspect_with(
    candidate: &Candidate,
    run: &str,
    observer: &impl Inspection,
) -> Result<Snapshot, CandidateError> {
    stable(&directory(candidate, run)?, || {
        observer.verify()?;
        let snapshot = inspect_using(candidate, observer, run)?;
        observer.verify()?;
        if snapshot.journal_incomplete {
            return Err(changed());
        }
        Ok(snapshot)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Read<'a> {
        receipt: &'a Receipt,
        during: &'a dyn Fn(),
    }
    impl Inspection for Read<'_> {
        fn incarnation(&self) -> &str {
            &self.receipt.owner
        }
        fn boot_id(&self) -> Result<&str, CandidateError> {
            Ok("fixture-boot")
        }
        fn verify(&self) -> Result<(), CandidateError> {
            Ok(())
        }
        fn get(&self, _: &str) -> Result<Value, CandidateError> {
            (self.during)();
            let resource = &self.receipt.resources["container:web"];
            Ok(
                json!({"Id":resource.id,"Name":resource.name,"Image":resource.image,
                "Config":{"Labels":expected_labels(self.receipt, resource)},
                "State":{"Status":"running","Running":true}}),
            )
        }
        fn probe_status(&self, _: &str) -> Result<Option<String>, CandidateError> {
            panic!("fixture has no probe")
        }
    }

    fn fixture() -> (super::super::tests::Fixture, Candidate, Receipt, PathBuf) {
        let fixture = super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&fixture.0).unwrap();
        let receipt: Receipt = serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"ready-observed","readiness":{"web":"started"},"resources":{"container:web":{"key":"web","kind":"container","name":format!("hkg-{}-container-0", "a".repeat(32)),"id":"e".repeat(64),"phase":"started","image":format!("sha256:{}", "f".repeat(64))}}})).unwrap();
        let root = directory(&candidate, &receipt.run).unwrap();
        state::private_directory(&root).unwrap();
        state::write(&root.join("state.json"), &receipt).unwrap();
        (fixture, candidate, receipt, root)
    }

    #[test]
    fn status_and_mutation_overlap_without_taking_each_others_lease() {
        let (_fixture, candidate, receipt, root) = fixture();
        let pool = candidate.state_root.join("run/smolvm");
        let before = fs::read(root.join("state.json")).unwrap();
        {
            let held = state::Lock::acquire(&pool).unwrap();
            let calls = Cell::new(0);
            let read = Read {
                receipt: &receipt,
                during: &|| {
                    calls.set(calls.get() + 1);
                    // A second mutation still refuses while the first holds the lease.
                    assert!(
                        matches!(state::Lock::acquire(&pool), Err(e) if e.code == "provider_busy")
                    );
                },
            };
            let snapshot = inspect_with(&candidate, &receipt.run, &read).unwrap();
            assert_eq!(snapshot.observations["container:web"]["state"], "running");
            assert_eq!(calls.get(), 1);
            drop(held);
            // A mutation arriving in the middle of a status GET can acquire immediately.
            let read = Read {
                receipt: &receipt,
                during: &|| {
                    let _start = state::Lock::acquire(&pool).unwrap();
                },
            };
            inspect_with(&candidate, &receipt.run, &read).unwrap();
        }
        assert_eq!(fs::read(root.join("state.json")).unwrap(), before);
    }

    #[test]
    fn journal_change_during_status_never_returns_a_mixed_snapshot() {
        for mode in ["replace", "pending", "rewrite"] {
            let (_fixture, candidate, receipt, root) = fixture();
            let read = Read {
                receipt: &receipt,
                during: &|| match mode {
                    "replace" => {
                        let mut changed = receipt.clone();
                        changed.phase = "cleanup-intent".into();
                        state::write(&root.join("state.json"), &changed).unwrap();
                    }
                    "pending" => {
                        fs::write(root.join("state.pending"), b"intent").unwrap();
                        fs::remove_file(root.join("state.pending")).unwrap();
                    }
                    _ => {
                        fs::write(root.join("state.json"), b"interrupted").unwrap();
                    }
                },
            };
            assert_eq!(
                inspect_with(&candidate, &receipt.run, &read)
                    .err()
                    .unwrap()
                    .code,
                "graph_status_changed"
            );
        }
    }
}
