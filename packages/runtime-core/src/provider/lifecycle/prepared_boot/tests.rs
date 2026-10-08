use super::*;

/// A candidate with a small provider tree to clone, and a private store.
struct Fixture {
    root: PathBuf,
    candidate: Candidate,
    store: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-prepared-work-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let checkout = root.join("checkout");
        fs::create_dir(&checkout).unwrap();
        let candidate = Candidate::discover(&checkout).unwrap();
        // Work roots clone the provider tree; its contents do not matter here.
        let providers = candidate.state_root.join("providers").join("fixture");
        state::private_directory(&providers).unwrap();
        fs::write(providers.join("file"), b"provider").unwrap();
        let store = root.join("store");
        state::private_directory(&store).unwrap();
        Self {
            root,
            candidate,
            store,
        }
    }

    fn roots(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.store.join(WORK))
            .map(|entries| {
                entries
                    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn root_name(work: &Work) -> String {
        work.dir.file_name().unwrap().to_string_lossy().into_owned()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// The first non-empty report after a lock was released, by its creator or by a previous
/// recovery probe. A fork-based spawn in another test thread briefly holds a copy of every
/// descriptor until it execs, so a released lock can stay held for moments and recovery skips
/// the root as live; a lock that is never released still fails after two seconds.
fn after_release(store: &Path, remove: bool) -> Vec<AbandonedWork> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let report = abandoned_work(store, remove).unwrap();
        if !report.is_empty() || Instant::now() >= deadline {
            return report;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn abandoned(root: &str, removed: bool, kept: Option<&str>) -> AbandonedWork {
    AbandonedWork {
        root: root.into(),
        removed,
        kept: kept.map(Into::into),
    }
}

#[test]
fn a_live_work_root_is_untouched_and_recovered_once_its_creator_is_gone() {
    let fixture = Fixture::new("live");
    let work = Work::create(&fixture.candidate, &fixture.store).unwrap();
    let name = Fixture::root_name(&work);
    // Held by a live creator: neither reported nor removed.
    assert_eq!(abandoned_work(&fixture.store, true).unwrap(), []);
    assert_eq!(fixture.roots(), [name.as_str()]);
    // An interrupted build ends without teardown; the kernel releases its lock.
    drop(work);
    assert_eq!(
        after_release(&fixture.store, false),
        [abandoned(&name, false, None)]
    );
    assert_eq!(fixture.roots(), [name.as_str()], "status never removes");
    // The status probe itself held the lock a moment ago.
    assert_eq!(
        after_release(&fixture.store, true),
        [abandoned(&name, true, None)]
    );
    assert!(fixture.roots().is_empty());
    // A missing work directory is simply nothing to recover.
    let empty = Fixture::new("none");
    assert_eq!(abandoned_work(&empty.store, true).unwrap(), []);
}

#[test]
fn an_empty_unlocked_root_is_removed_and_other_entries_are_kept() {
    let fixture = Fixture::new("entries");
    let parent = fixture.store.join(WORK);
    state::private_directory(&parent).unwrap();
    let hex = |digit: char| std::iter::repeat_n(digit, 32).collect::<String>();
    // Its creator stopped between creating the directory and taking the lock.
    fs::create_dir(parent.join(hex('a'))).unwrap();
    // Content without a lock is not something a work root ever has.
    fs::create_dir(parent.join(hex('b'))).unwrap();
    fs::write(parent.join(hex('b')).join("file"), b"x").unwrap();
    std::os::unix::fs::symlink(&fixture.root, parent.join(hex('c'))).unwrap();
    fs::create_dir(parent.join("not-a-work-root")).unwrap();
    let report = abandoned_work(&fixture.store, true).unwrap();
    assert_eq!(
        report,
        [
            abandoned(&hex('a'), true, None),
            abandoned(&hex('b'), false, Some("work_lock_missing")),
            abandoned(&hex('c'), false, Some("foreign_state")),
            abandoned("not-a-work-root", false, Some("foreign_state")),
        ],
    );
    assert_eq!(
        fixture.roots(),
        [hex('b'), hex('c'), "not-a-work-root".into()]
    );
}

#[test]
fn an_abandoned_root_whose_provider_still_runs_is_kept_until_it_exits() {
    let fixture = Fixture::new("provider");
    let work = Work::create(&fixture.candidate, &fixture.store).unwrap();
    let name = Fixture::root_name(&work);
    // Run an owned executable at the work root's exact provider path.
    let provider = binary(&work.candidate);
    fs::create_dir_all(provider.parent().unwrap()).unwrap();
    crate::provider::test_executable::sleeping_executable(&provider);
    let mut running = std::process::Command::new(&provider)
        .arg("30")
        .spawn()
        .unwrap();
    drop(work);
    let first = after_release(&fixture.store, true);
    running.kill().unwrap();
    running.wait().unwrap();
    assert_eq!(first, [abandoned(&name, false, Some("stop_uncertain"))]);
    assert_eq!(fixture.roots(), [name.as_str()]);
    // The first probe itself held the lock a moment ago.
    assert_eq!(
        after_release(&fixture.store, true),
        [abandoned(&name, true, None)]
    );
}

#[test]
fn a_receipt_without_its_alias_is_removed_only_before_its_machine_was_created() {
    for (created, removed) in [(false, true), (true, false)] {
        let fixture = Fixture::new(&format!("receipt-{created}"));
        let work = Work::create(&fixture.candidate, &fixture.store).unwrap();
        // The receipt is saved just before its alias; this build stopped in between.
        let token = random_hex().unwrap();
        state::private_directory(&root(&work.candidate)).unwrap();
        let owner = serde_json::json!({
            "version": 1, "checkout": work.candidate.checkout, "token": token,
            "machine": format!("hack-{}", &token[..12]),
            "short_home": format!("/private/tmp/hkl-{}", &token[..12]),
            "created": created, "phase": "initializing", "process": null, "storage": null,
            "overlay": null, "guest_boot_id": null, "daemon_pid": null, "daemon_start": null,
            "rootfs_digest": null
        });
        // Receipts are always private.
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(root(&work.candidate).join("owner.json"))
            .and_then(|mut file| {
                std::io::Write::write_all(&mut file, &serde_json::to_vec(&owner).unwrap())
            })
            .unwrap();
        drop(work);
        let report = after_release(&fixture.store, true);
        assert_eq!(report.len(), 1, "{report:?}");
        assert_eq!(report[0].removed, removed, "{report:?}");
        assert_eq!(fixture.roots().is_empty(), removed);
    }
}
