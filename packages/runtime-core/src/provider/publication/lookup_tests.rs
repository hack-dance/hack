//! Exercise real registry writes and revalidation without a macOS publisher.
use super::*;
use std::sync::mpsc::sync_channel;
use std::time::Duration;

struct Fixture {
    candidate: Candidate,
    live: Entry,
    sibling: Entry,
}

impl Fixture {
    fn new() -> Self {
        let base = crate::private_test_root(&std::env::temp_dir(), "hack-publication-lookup");
        let candidate = Candidate::discover(&base).unwrap();
        let mut live = Entry {
            owner: "a".repeat(32),
            run: "b".repeat(32),
            reservation: "c".repeat(32),
            slot: 0,
            port: 0,
            unix: true,
            hostnames: vec!["live.example.test".into()],
            token: "d".repeat(32),
            process: identity::ProcessIdentity {
                pid: 4242,
                start_micros: 1,
                // SAFETY: geteuid has no preconditions.
                uid: unsafe { libc::geteuid() },
                executable: PathBuf::new(),
            },
            digest: "e".repeat(64),
            directory: Some((1, 2)),
            binary: Some(BinaryStage {
                device: 1,
                inode: 3,
                ready: true,
            }),
            reaped: None,
        };
        live.process.executable = directory(&live).join("publisher");
        let mut sibling = live.clone();
        sibling.run = "f".repeat(32);
        sibling.reservation = "0".repeat(32);
        sibling.slot = 1;
        sibling.hostnames = vec!["sibling.example.test".into()];
        sibling.process.executable = directory(&sibling).join("publisher");
        sibling.directory = None;
        sibling.binary = None;
        let fixture = Self {
            candidate,
            live,
            sibling,
        };
        save(&fixture.candidate, &fixture.committed()).unwrap();
        fixture
    }

    fn committed(&self) -> BTreeMap<String, Entry> {
        BTreeMap::from([(self.live.reservation.clone(), self.live.clone())])
    }

    fn claiming_sibling(&self) -> BTreeMap<String, Entry> {
        let mut entries = self.committed();
        entries.insert(self.sibling.reservation.clone(), self.sibling.clone());
        entries
    }

    fn lookup(
        &self,
        name: &str,
        observe: impl FnOnce(&Entry) -> Result<(), CandidateError>,
    ) -> Result<Entry, CandidateError> {
        observe_hostname_claim(
            &self.candidate,
            name,
            || Ok(self.live.owner.clone()),
            observe,
        )
    }

    fn assert_live_lookup(&self) {
        let entry = self
            .lookup(&self.live.hostnames[0], |_| Ok(()))
            .expect("sibling journal must not deny the live hostname");
        assert!(entry == self.live);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.candidate.checkout).unwrap();
    }
}

#[test]
fn legacy_journal_refusal_denies_live_route_but_committed_lookup_ignores_pending() {
    let fixture = Fixture::new();
    let entries = fixture.claiming_sibling();
    let c = &fixture.candidate;
    let _lease = state::Lock::acquire(&c.state_root.join("run/smolvm")).unwrap();
    // Leave the real pending file behind after syncing it, without committing.
    assert!(save_before_rename(c, &entries, &|| Err(error())).is_err());
    let pending = root(c).join("state.pending");
    let before = fs::read(&pending).unwrap();
    // The old lookup used this same settled-registry reader. The authority
    // converts publisher_intent to HTTP 403 before inspecting the publisher.
    assert_eq!(
        load(c, &fixture.live.owner).err().unwrap().code,
        "publisher_intent"
    );
    fixture.assert_live_lookup();
    assert!(
        fixture
            .lookup(&fixture.sibling.hostnames[0], |_| panic!(
                "pending claim was selected"
            ))
            .is_err()
    );
    assert_eq!(fs::read(pending).unwrap(), before);
}

#[test]
fn committed_lookup_checks_the_selected_claim_after_observation() {
    let fixture = Fixture::new();
    let name = &fixture.live.hostnames[0];
    let c = &fixture.candidate;
    let _lease = state::Lock::acquire(&c.state_root.join("run/smolvm")).unwrap();
    let entries = fixture.claiming_sibling();
    assert!(fixture.lookup(name, |_| save(c, &entries)).unwrap() == fixture.live);

    let mut after = entries;
    after.remove(&fixture.live.reservation);
    assert_eq!(
        fixture
            .lookup(name, |_| save(c, &after))
            .err()
            .unwrap()
            .code,
        "publication_changed"
    );
}

#[test]
fn live_hostname_lookup_survives_concurrent_sibling_publication_and_retirement() {
    const CYCLES: usize = 128;
    const LOOKUPS_PER_WINDOW: usize = 8;
    const WRITES_PER_CYCLE: usize = 3;
    let fixture = &Fixture::new();
    let absent = fixture.committed();
    let claimed = fixture.claiming_sibling();
    let mut staged = claimed.clone();
    staged
        .get_mut(&fixture.sibling.reservation)
        .unwrap()
        .directory = Some((1, 4));

    std::thread::scope(|scope| {
        let (pending_tx, pending_rx) = sync_channel(0);
        let (resume_tx, resume_rx) = sync_channel(0);
        scope.spawn(move || {
            for _ in 0..CYCLES {
                let c = &fixture.candidate;
                let _lease = state::Lock::acquire(&c.state_root.join("run/smolvm")).unwrap();
                for entries in [&claimed, &staged, &absent] {
                    save_before_rename(c, entries, &|| {
                        pending_tx.send(()).unwrap();
                        resume_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                        Ok(())
                    })
                    .unwrap();
                }
            }
        });
        for _ in 0..CYCLES * WRITES_PER_CYCLE {
            pending_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            for _ in 0..LOOKUPS_PER_WINDOW {
                fixture.assert_live_lookup();
            }
            resume_tx.send(()).unwrap();
            for _ in 0..LOOKUPS_PER_WINDOW {
                fixture.assert_live_lookup();
            }
        }
    });
    fixture.assert_live_lookup();
}
