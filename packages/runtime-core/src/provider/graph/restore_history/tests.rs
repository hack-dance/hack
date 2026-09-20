use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};
fn receipt(index: usize) -> Receipt {
    Receipt {
        normalized_input: None,
        relay_startup: None,
        relay_cleanup: None,
        version: 1,
        run: "a".repeat(32),
        owner: "b".repeat(32),
        namespace: "c".repeat(64),
        plan_id: "d".repeat(64),
        phase: "stopped-data-retained".into(),
        environment_attached: false,
        initializer_cache_release: BTreeMap::new(),
        source: None,
        readiness: BTreeMap::new(),
        probes: BTreeMap::new(),
        resources: BTreeMap::from([(
            "container:web".into(),
            Resource {
                routing: None,
                networks: None,
                outbound: false,
                cache: None,
                cache_provenance: None,
                kind: Kind::Container,
                key: "web".into(),
                name: "owned-web".into(),
                id: Some(format!("{index:064x}")),
                image: None,
                phase: "absent".into(),
            },
        )]),
    }
}
fn private_write(path: &Path, value: &[u8]) {
    fs::write(path, value).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
fn legacy(root: &Path, count: usize) {
    for index in 1..=count {
        let path = root.join(format!("restore-{index}"));
        state::private_directory(&path).unwrap();
        state::write(&path.join("previous.json"), &receipt(index)).unwrap();
    }
}
#[test]
fn repeated_restores_keep_recent_bounded_history_and_never_touch_authority_or_data() {
    let fixture = super::super::tests::Fixture::new();
    let root = &fixture.0;
    state::write(&root.join("state.json"), &receipt(0)).unwrap();
    private_write(&root.join("named-data"), b"persistent marker");
    let authority = fs::read(root.join("state.json")).unwrap();
    for index in 1..=40 {
        retain(root, &receipt(index)).unwrap();
    }
    let history: History = state::read(&root.join(FILE)).unwrap();
    assert!(history.truncated);
    assert_eq!(history.entries.len(), 8);
    for (offset, entry) in history.entries.iter().enumerate() {
        assert_eq!(
            entry.resources["container:web"].id,
            Some(format!("{:064x}", offset + 33))
        );
    }
    assert!(fs::metadata(root.join(FILE)).unwrap().len() <= BYTE_LIMIT as u64);
    assert_eq!(fs::read(root.join("state.json")).unwrap(), authority);
    assert_eq!(
        fs::read(root.join("named-data")).unwrap(),
        b"persistent marker"
    );
    retain(root, &receipt(40)).unwrap();
    let after: History = state::read(&root.join(FILE)).unwrap();
    assert_eq!(bytes(&after).unwrap(), bytes(&history).unwrap());
}
#[test]
fn migration_publishes_bounded_history_and_export_before_retiring_legacy() {
    let fixture = super::super::tests::Fixture::new();
    let root = &fixture.0;
    legacy(root, 8);
    retain(root, &receipt(9)).unwrap();
    let history: History = state::read(&root.join(FILE)).unwrap();
    assert_eq!(history.entries.len(), 8);
    assert!(history.truncated);
    assert_eq!(history.legacy.len(), 8);
    assert_eq!(
        history.entries[0].resources["container:web"].id,
        receipt(2).resources["container:web"].id
    );
    assert!(legacy_paths(root).unwrap().is_empty());
    let (bundle, count) = super::super::export::bundle(root).unwrap();
    assert_eq!(count, 1);
    let mut archive = tar::Archive::new(std::io::Cursor::new(bundle));
    let names = archive
        .entries()
        .unwrap()
        .map(|e| e.unwrap().path().unwrap().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(names, vec![PathBuf::from(FILE)]);
}
#[test]
fn interrupted_publication_recovers_only_a_known_deterministic_prefix() {
    for prefix in [0, 10, usize::MAX] {
        let fixture = super::super::tests::Fixture::new();
        let root = &fixture.0;
        retain(root, &receipt(1)).unwrap();
        let old = fs::read(root.join(FILE)).unwrap();
        let expected = bytes(&next(root, &receipt(2)).unwrap()).unwrap();
        private_write(
            &root.join("restore-history.pending"),
            &expected[..prefix.min(expected.len())],
        );
        assert_eq!(fs::read(root.join(FILE)).unwrap(), old);
        retain(root, &receipt(2)).unwrap();
        assert_eq!(fs::read(root.join(FILE)).unwrap(), expected);
        assert!(!root.join("restore-history.pending").exists());
    }
    let fixture = super::super::tests::Fixture::new();
    let root = &fixture.0;
    retain(root, &receipt(1)).unwrap();
    let old = fs::read(root.join(FILE)).unwrap();
    private_write(
        &root.join("restore-history.pending"),
        b"foreign or corrupt bytes",
    );
    assert!(retain(root, &receipt(2)).is_err());
    assert_eq!(fs::read(root.join(FILE)).unwrap(), old);
    assert_eq!(
        fs::read(root.join("restore-history.pending")).unwrap(),
        b"foreign or corrupt bytes"
    );
}
#[test]
fn interrupted_legacy_retirement_resumes_after_commit_without_duplicate_capture() {
    let fixture = super::super::tests::Fixture::new();
    let root = &fixture.0;
    legacy(root, 8);
    let history = next(root, &receipt(9)).unwrap();
    state::write(&root.join(FILE), &history).unwrap();
    fs::remove_file(root.join("restore-1/previous.json")).unwrap();
    retain(root, &receipt(9)).unwrap();
    assert!(legacy_paths(root).unwrap().is_empty());
    assert_eq!(fs::read(root.join(FILE)).unwrap(), bytes(&history).unwrap());
}
#[test]
fn unknown_legacy_contents_and_identity_are_preserved() {
    for mode in [0, 1, 2] {
        let fixture = super::super::tests::Fixture::new();
        let root = &fixture.0;
        legacy(root, 1);
        if mode == 0 {
            private_write(&root.join("restore-1/foreign"), b"keep");
        }
        if mode == 1 {
            let mut foreign = receipt(1);
            foreign.run = "e".repeat(32);
            state::write(&root.join("restore-1/previous.json"), &foreign).unwrap();
        }
        if mode == 2 {
            fs::remove_file(root.join("restore-1/previous.json")).unwrap();
        }
        assert!(retain(root, &receipt(2)).is_err());
        assert!(root.join("restore-1").exists());
        assert!(!root.join(FILE).exists());
    }
}
#[test]
fn symlinks_and_hardlinks_never_authorize_retirement() {
    for name in [FILE, "restore-history.pending", "restore-1"] {
        let fixture = super::super::tests::Fixture::new();
        let root = &fixture.0;
        private_write(&root.join("foreign"), b"keep");
        symlink(root.join("foreign"), root.join(name)).unwrap();
        assert!(retain(root, &receipt(1)).is_err());
        assert_eq!(fs::read(root.join("foreign")).unwrap(), b"keep");
        assert!(root.join(name).is_symlink());
    }
    let fixture = super::super::tests::Fixture::new();
    let root = &fixture.0;
    legacy(root, 1);
    fs::hard_link(root.join("restore-1/previous.json"), root.join("foreign")).unwrap();
    assert!(retain(root, &receipt(2)).is_err());
    assert!(root.join("restore-1/previous.json").exists());
}
#[test]
fn byte_budget_retires_old_diagnostics_and_refuses_oversized_latest_state() {
    let fixture = super::super::tests::Fixture::new();
    let root = &fixture.0;
    for index in 0..4 {
        let mut r = receipt(index);
        r.resources.get_mut("container:web").unwrap().name = "x".repeat(400_000);
        retain(root, &r).unwrap();
    }
    let history: History = state::read(&root.join(FILE)).unwrap();
    assert_eq!(history.entries.len(), 2);
    assert!(history.truncated);
    let before = fs::read(root.join(FILE)).unwrap();
    let mut huge = receipt(5);
    huge.resources.get_mut("container:web").unwrap().name = "x".repeat(BYTE_LIMIT);
    assert!(retain(root, &huge).is_err());
    assert_eq!(fs::read(root.join(FILE)).unwrap(), before);
}

#[test]
#[ignore = "Subprocess crash-control helper"]
fn history_crash_child() {
    let root = PathBuf::from(std::env::var("HACK_HISTORY_TEST_ROOT").unwrap());
    retain(&root, &receipt(9)).unwrap();
    panic!("crash control did not reach its fault point");
}
#[test]
fn process_death_before_publication_and_during_retirement_is_recoverable() {
    use std::{
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };
    struct Guard(Child);
    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    for point in [
        "history-before-publication",
        "history-published",
        "history-retired-entry",
    ] {
        let fixture = super::super::tests::Fixture::new();
        let root = &fixture.0;
        legacy(root, 8);
        state::write(&root.join("state.json"), &receipt(9)).unwrap();
        let authority = fs::read(root.join("state.json")).unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "provider::graph::restore_history::tests::history_crash_child",
                "--ignored",
            ])
            .env("HACK_HISTORY_TEST_ROOT", root)
            .env("HACK_LOCAL_GRAPH_FAULT", point)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut child = Guard(child);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.join(format!("fault-{point}.json")).exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "helper exited before fault point"
            );
            assert!(Instant::now() < deadline, "fault point not reached");
            std::thread::sleep(Duration::from_millis(5));
        }
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        if point == "history-before-publication" {
            assert!(!root.join(FILE).exists());
            assert_eq!(legacy_paths(root).unwrap().len(), 8);
        }
        retain(root, &receipt(9)).unwrap();
        assert!(legacy_paths(root).unwrap().is_empty());
        assert_eq!(fs::read(root.join("state.json")).unwrap(), authority);
        let history: History = state::read(&root.join(FILE)).unwrap();
        assert_eq!(history.entries.len(), 8);
        assert_eq!(
            history.entries.last().unwrap().resources["container:web"].id,
            receipt(9).resources["container:web"].id
        );
    }
}
