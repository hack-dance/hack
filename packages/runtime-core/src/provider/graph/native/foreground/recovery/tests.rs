use super::*;
use hack_config_compiler::environment::EnvMetadata;
use std::{
    fs::OpenOptions,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};

const RUN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER: &str = "cccccccccccccccccccccccccccccccc";
const PUBLISHER: &str = "provider::graph::native::foreground::recovery::tests::publisher_fixture";
struct Fixture {
    root: PathBuf,
    candidate: Candidate,
    remove: bool,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "native-selector-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        for path in [
            &root,
            &root.join("home"),
            &root.join("project"),
            &root.join("project/.hack"),
        ] {
            fs::DirBuilder::new().mode(0o700).create(path).unwrap();
        }
        fs::write(
            root.join("project/.hack/hack.project.json"),
            json!({
                "schema_version":1,"name":"selector","services":{"web":{
                    "image":format!("sha256:{}", "d".repeat(64)),
                    "command":{"exec":["/bin/echo","$EXACT"]}
                }}
            })
            .to_string(),
        )
        .unwrap();
        Self::at(root, true)
    }
    fn at(root: PathBuf, remove: bool) -> Self {
        state::check_private_directory(&root).unwrap();
        Self {
            candidate: Candidate::discover(&root.join("home")).unwrap(),
            root,
            remove,
        }
    }
    fn ready(&self) -> Receipt {
        let private = self.root.join("private-canary").exists();
        let metadata: EnvMetadata = serde_json::from_value(json!({
            "metadata_version":1,"overlay":null,"overlay_exists":false,
            "workloads":{"web": if private {json!({"SELECTOR_SOURCE_KEY_CANARY":{"scope":"web","secret":true}})} else {json!({})}},"inactive_scopes":[]
        }))
        .unwrap();
        let values = if private {
            BTreeMap::from([(
                "web".into(),
                BTreeMap::from([(
                    "SELECTOR_SOURCE_KEY_CANARY".into(),
                    "selector-private-value-canary".into(),
                )]),
            )])
        } else {
            BTreeMap::new()
        };
        let prepared = selection::select(
            &self.candidate,
            selection::Options {
                project: &self.root.join("project"),
                branch: Some("fixture"),
                run: RUN,
                profiles: &[],
                explicit_overlay: None,
                metadata,
                deadline: Instant::now() + Duration::from_secs(60),
            },
        )
        .unwrap()
        .prepare(&self.candidate, &values)
        .unwrap();
        let config = configuration(prepared.input(), OWNER).unwrap();
        if private {
            let public = config.containers()["web"].to_string();
            assert!(public.contains("selector-argv-canary"));
            assert!(public.contains("selector-literal-canary"));
            assert!(!public.contains("selector-private-value-canary"));
        }
        let mut receipt =
            Receipt::preparing(&config, OWNER, "12345678-abcd-abcd-abcd-123456789abc").unwrap();
        receipt.phase = Phase::ReadyObserved;
        for (index, resource) in receipt.resources.values_mut().enumerate() {
            resource.id = Some(format!("{:064x}", index + 1));
            resource.phase = if resource.kind == Kind::Network {
                "created"
            } else {
                "started"
            }
            .into();
        }
        receipt.require_recovery_ready().unwrap();
        receipt
    }
    fn publisher(&self, live: bool) -> Child {
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", PUBLISHER, "--nocapture"])
            .env("HACK_NATIVE_SELECTOR_ROOT", &self.root)
            .env("HACK_NATIVE_SELECTOR_LIVE", if live { "1" } else { "0" })
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap()
    }
    fn published(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.root.join("published").exists() {
            assert!(
                Instant::now() < deadline,
                "fixture publication did not settle"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn dead(&self) {
        let mut child = self.publisher(false);
        assert!(child.wait().unwrap().success());
        self.published();
    }
    fn owner_root(&self) -> PathBuf {
        owner::root(&self.candidate, RUN).unwrap()
    }
    fn journal_root(&self) -> PathBuf {
        journal::directory(&self.candidate, RUN).unwrap()
    }
    fn receipt(&self) -> Receipt {
        serde_json::from_slice(&fs::read(self.journal_root().join("state.json")).unwrap()).unwrap()
    }
    fn intent(&self) -> Intent {
        let lease =
            owner::RecoveryLease::acquire(&self.candidate, RUN, None, false, false).unwrap();
        let original = fs::read_to_string(self.journal_root().join("state.json")).unwrap();
        let receipt = self.receipt();
        Intent {
            version: 1,
            kind: IntentKind::NativeGraphLiveOwnerRecovery,
            run: RUN.into(),
            journal_parent: id(&self.journal_root()).unwrap(),
            receipt_sha256: digest(original.as_bytes()),
            original,
            publication: lease.selected().clone(),
            progress: Progress::Cleanup,
            receipt_progress: 0,
            resource_progress: resource_progress(&receipt).unwrap(),
            environment: crate::provider::native_environment::Inventory::capture(
                &self.candidate,
                &receipt,
            )
            .unwrap(),
        }
    }
    fn store(&self, intent: &Intent) {
        state::write(&self.journal_root().join(FILE), intent).unwrap();
    }
    fn assert_refused_unchanged(&self) {
        let original_owner = fs::read(self.owner_root().join("owner.json")).unwrap();
        let original_state = fs::read(self.journal_root().join("state.json")).unwrap();
        let lock = id(&self.owner_root().join("operation.lock")).unwrap();
        assert!(select(&self.candidate, RUN).is_err());
        assert_eq!(
            fs::read(self.owner_root().join("owner.json")).unwrap(),
            original_owner
        );
        assert_eq!(
            fs::read(self.journal_root().join("state.json")).unwrap(),
            original_state
        );
        assert_eq!(id(&self.owner_root().join("operation.lock")).unwrap(), lock);
        assert!(!self.candidate.state_root.join("run/smolvm").exists());
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.remove {
            let _ = fs::remove_dir_all(self.owner_root());
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
}
struct RetainedChild(Child);
impl Drop for RetainedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A real process owns the ordinary publication and lock. No engine is used;
/// the Ready receipt is a typed real-compiler fixture, not a runtime claim.
#[test]
fn publisher_fixture() {
    let Some(root) = std::env::var_os("HACK_NATIVE_SELECTOR_ROOT") else {
        return;
    };
    let fixture = Fixture::at(PathBuf::from(root), false);
    let receipt = fixture.ready();
    let _publication = owner::Publication::bind(&fixture.candidate, &receipt.review).unwrap();
    journal::reserve(&fixture.candidate, &receipt).unwrap();
    let mut marker = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(fixture.root.join("published"))
        .unwrap();
    marker.write_all(b"published").unwrap();
    marker.sync_all().unwrap();
    if std::env::var_os("HACK_NATIVE_SELECTOR_LIVE").as_deref() == Some(std::ffi::OsStr::new("1")) {
        std::thread::sleep(Duration::from_secs(30));
    }
    // Deliberately retain the original paths after this exact process exits.
}

#[test]
fn dead_complete_publication_selects_original_raw_hash_without_creating_authority() {
    let fixture = Fixture::new();
    fixture.dead();
    let state_path = fixture.journal_root().join("state.json");
    let original = fs::read(&state_path).unwrap();
    let owner_path = fixture.owner_root().join("owner.json");
    let original_owner = fs::read(&owner_path).unwrap();
    let state_id = id(&state_path).unwrap();
    let owner_id = id(&owner_path).unwrap();
    let lock_id = id(&fixture.owner_root().join("operation.lock")).unwrap();
    let selected = select(&fixture.candidate, RUN).unwrap();
    assert_eq!(selected.receipt_sha256, digest(&original));
    assert_eq!(selected.owner_sha256, digest(&original_owner));
    assert_ne!(
        selected.receipt_sha256,
        digest(&serde_json::to_vec(&selected.receipt).unwrap())
    );
    assert!(
        serde_json::to_value(&selected).unwrap()["host_boot_uuid"]
            == serde_json::to_value(host_boot::read().unwrap()).unwrap(),
        "Selection must retain the observed boot qualifier"
    );
    assert_eq!(fs::read(&state_path).unwrap(), original);
    assert_eq!(id(&state_path).unwrap(), state_id);
    assert_eq!(fs::read(&owner_path).unwrap(), original_owner);
    assert_eq!(id(&owner_path).unwrap(), owner_id);
    assert_eq!(
        id(&fixture.owner_root().join("operation.lock")).unwrap(),
        lock_id
    );
    assert!(!fixture.journal_root().join(FILE).exists());
    assert!(!fixture.candidate.state_root.join("run/smolvm").exists());
    assert_eq!(
        serde_json::to_value(&selected)
            .unwrap()
            .as_object()
            .unwrap()
            .len(),
        7
    );
}

#[cfg(feature = "environment-launcher")]
#[test]
fn selection_json_excludes_real_compiler_argv_environment_keys_values_and_owner_bytes() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("private-canary"), b"fixture").unwrap();
    fs::write(
        fixture.root.join("project/.hack/hack.project.json"),
        json!({
            "schema_version":1,"name":"selector","services":{"web":{
                "image":format!("sha256:{}", "d".repeat(64)),
                "command":{"exec":["/bin/echo","selector-argv-canary","$EXACT"]},
                "environment":{
                    "SELECTOR_LITERAL_KEY_CANARY":{"literal":"selector-literal-canary"},
                    "SELECTOR_DEST_KEY_CANARY":{"env_ref":"SELECTOR_SOURCE_KEY_CANARY"}
                }
            }}
        })
        .to_string(),
    )
    .unwrap();
    fixture.dead();
    let intent = fixture.intent();
    assert!(
        serde_json::to_string(&intent.publication)
            .unwrap()
            .contains(fixture.root.to_str().unwrap())
    );
    fixture.store(&intent);
    let selected = select(&fixture.candidate, RUN).unwrap();
    let wire = serde_json::to_value(&selected).unwrap();
    let text = wire.to_string();
    for canary in [
        "selector-argv-canary",
        "$EXACT",
        "selector-literal-canary",
        "selector-private-value-canary",
        "SELECTOR_LITERAL_KEY_CANARY",
        "SELECTOR_DEST_KEY_CANARY",
        "SELECTOR_SOURCE_KEY_CANARY",
        fixture.root.to_str().unwrap(),
        "\"command\":",
        "\"environment\":",
        "\"argv\":",
        "\"process\":",
        "\"publication\":",
        "\"original\":",
    ] {
        assert!(
            !text.contains(canary),
            "selection leaked protected compiler/owner material"
        );
    }
    assert_eq!(
        wire.as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "host_boot_uuid",
            "kind",
            "owner_sha256",
            "receipt",
            "receipt_sha256",
            "run",
            "version"
        ]
    );
    assert_eq!(wire["receipt"]["phase"], "ready-observed");
    assert!(super::super::super::super::hex(
        wire["receipt"]["review"]["provenance"]["input"]["environment_policy_hash"]
            .as_str()
            .unwrap(),
        64
    ));
    assert_eq!(
        wire["receipt"]["resources"]["container:web"]["id"],
        selected.receipt.resources["container:web"]
            .id
            .as_deref()
            .unwrap()
    );
    assert!(!fixture.candidate.state_root.join("run/smolvm").exists());
}

#[test]
fn live_exact_publisher_never_yields_dead_recovery_authority() {
    let fixture = Fixture::new();
    let mut child = RetainedChild(fixture.publisher(true));
    fixture.published();
    assert!(child.0.try_wait().unwrap().is_none());
    fixture.assert_refused_unchanged();
    assert!(child.0.try_wait().unwrap().is_none());
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    assert!(select(&fixture.candidate, RUN).is_ok());
}

#[test]
fn dead_old_two_wrong_boot_and_unknown_publication_fields_refuse() {
    for case in ["old-two", "wrong-boot", "unknown"] {
        let fixture = Fixture::new();
        fixture.dead();
        let path = fixture.owner_root().join("owner.json");
        let mut owner: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        match case {
            "old-two" => {
                owner["version"] = json!(2);
                owner.as_object_mut().unwrap().remove("host_boot_uuid");
            }
            "wrong-boot" => owner["host_boot_uuid"] = json!("00000000-0000-0000-0000-000000000001"),
            "unknown" => owner["cleanup_authority"] = json!(true),
            _ => unreachable!(),
        }
        fs::write(&path, owner.to_string()).unwrap();
        fixture.assert_refused_unchanged();
    }
}

#[test]
fn legacy_three_selection_remains_version_one_without_uuid_migration() {
    let fixture = Fixture::new();
    fixture.dead();
    let path = fixture.owner_root().join("owner.json");
    let mut legacy: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    legacy["version"] = json!(3);
    legacy.as_object_mut().unwrap().remove("host_boot_uuid");
    let micros = crate::provider::host_filesystem::host_boot_micros().unwrap();
    legacy["host_boot_micros"] = json!(micros);
    fs::write(&path, legacy.to_string()).unwrap();
    let original = fs::read(&path).unwrap();
    let selected = serde_json::to_value(select(&fixture.candidate, RUN).unwrap()).unwrap();
    assert_eq!(selected["version"], 1);
    assert_eq!(selected["host_boot_micros"], micros);
    assert!(selected.get("host_boot_uuid").is_none());
    assert_eq!(fs::read(&path).unwrap(), original);
    legacy["host_boot_micros"] = json!(micros + 1);
    fs::write(&path, legacy.to_string()).unwrap();
    fixture.assert_refused_unchanged();
}

#[test]
fn recovery_session_entry_refusal_and_restoration_preserve_exact_evidence() {
    let fixture = Fixture::new();
    fixture.dead();
    let intent = fixture.intent();
    fixture.store(&intent);
    let lease = owner::RecoveryLease::acquire(
        &fixture.candidate,
        RUN,
        Some(intent.publication.clone()),
        false,
        false,
    )
    .unwrap();
    lease.verify(false, false).unwrap();
    for changed in [Some("12345678-abcd-abcd-abcd-123456789abc"), None] {
        let _drift = host_boot::test::Guard::set(changed);
        assert!(lease.verify(false, false).is_err());
        assert!(lease.review().is_err());
        assert!(lease.archive(true).is_err());
        assert!(select(&fixture.candidate, RUN).is_err());
        assert!(fixture.owner_root().join("owner.json").exists());
        assert!(fixture.owner_root().join("control.sock").exists());
    }
    lease.verify(false, false).unwrap();
}

#[test]
fn recovery_session_final_observation_refuses_drift_without_changing_original_evidence() {
    let fixture = Fixture::new();
    fixture.dead();
    let intent = fixture.intent();
    fixture.store(&intent);
    let lease = owner::RecoveryLease::acquire(
        &fixture.candidate,
        RUN,
        Some(intent.publication.clone()),
        false,
        false,
    )
    .unwrap();
    let current = serde_json::to_value(host_boot::read().unwrap())
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let mut changed = current.clone();
    changed.replace_range(0..1, if current.starts_with('f') { "e" } else { "f" });
    let owner = fixture.owner_root().join("owner.json");
    let socket = fixture.owner_root().join("control.sock");
    let journal = fixture.journal_root().join("state.json");
    let saved_intent = fixture.journal_root().join(FILE);
    let paths = [&owner, &socket, &journal, &saved_intent];
    let identities: Vec<_> = paths.iter().map(|path| id(path).unwrap()).collect();
    let bytes = [&owner, &journal, &saved_intent].map(|path| fs::read(path).unwrap());
    for last in [Some(changed.as_str()), None] {
        let _drift = host_boot::test::Guard::sequence(&[Some(&current), last]);
        // First record read admits the original boot; final read must refuse.
        assert!(lease.verify(false, false).is_err());
        for (path, expected) in paths.iter().zip(&identities) {
            assert_eq!(id(path).unwrap(), *expected);
        }
        for (path, expected) in [&owner, &journal, &saved_intent].into_iter().zip(&bytes) {
            assert!(
                fs::read(path).unwrap() == *expected,
                "Original evidence must remain unchanged"
            );
        }
    }
    lease.verify(false, false).unwrap();
}

#[test]
fn partial_failed_missing_id_or_pending_state_never_creates_an_intent() {
    for case in [
        "preparing",
        "failed",
        "missing-id",
        "state-pending",
        "intent-pending",
    ] {
        let fixture = Fixture::new();
        fixture.dead();
        let root = fixture.journal_root();
        let path = root.join("state.json");
        let mut receipt: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        match case {
            "preparing" => receipt["phase"] = json!("preparing"),
            "failed" => {
                receipt["failure"] = json!({"service":"web","observation":{"state":"dead"}})
            }
            "missing-id" => receipt["resources"]["container:web"]["id"] = Value::Null,
            "state-pending" => fs::write(root.join("state.pending"), b"retained").unwrap(),
            "intent-pending" => {
                fs::write(root.join("live-owner-recovery.pending"), b"retained").unwrap()
            }
            _ => unreachable!(),
        }
        if !case.ends_with("pending") {
            fs::write(&path, receipt.to_string()).unwrap();
        }
        fixture.assert_refused_unchanged();
        assert!(!root.join(FILE).exists());
    }
}

#[test]
fn replaced_selected_owner_or_published_socket_and_lock_refuse_without_repair() {
    for name in ["owner.json", "control.sock", "operation.lock"] {
        let fixture = Fixture::new();
        fixture.dead();
        if name == "owner.json" {
            // Publication4 carries no original owner-file inode. Its first
            // private snapshot becomes the saved intent's later inode anchor.
            fixture.store(&fixture.intent());
        }
        let path = fixture.owner_root().join(name);
        let original = if name == "owner.json" {
            Some(fs::read(&path).unwrap())
        } else {
            None
        };
        fs::rename(&path, path.with_extension("retained")).unwrap();
        if name == "control.sock" {
            let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            assert!(select(&fixture.candidate, RUN).is_err());
            drop(listener);
        } else {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
                .unwrap();
            file.write_all(original.as_deref().unwrap_or(b"")).unwrap();
            fixture.assert_refused_unchanged();
        }
    }
}

#[test]
fn first_selection_captures_current_private_same_byte_owner_snapshot() {
    let fixture = Fixture::new();
    fixture.dead();
    let path = fixture.owner_root().join("owner.json");
    let bytes = fs::read(&path).unwrap();
    let prior_id = id(&path).unwrap();
    fs::rename(&path, path.with_extension("retained")).unwrap();
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    file.write_all(&bytes).unwrap();
    file.sync_all().unwrap();
    assert_ne!(id(&path).unwrap(), prior_id);
    let selected = select(&fixture.candidate, RUN).unwrap();
    assert_eq!(selected.owner_sha256, digest(&bytes));
    fixture.store(&fixture.intent());
    fs::remove_file(&path).unwrap();
    fs::rename(path.with_extension("retained"), &path).unwrap();
    fixture.assert_refused_unchanged();
}

#[test]
fn committed_intent_keeps_original_hash_and_inventory_through_cleanup_progress() {
    let fixture = Fixture::new();
    fixture.dead();
    let mut intent = fixture.intent();
    let original_receipt = intent.receipt_sha256.clone();
    let original_owner = intent.publication.fingerprint();
    fixture.store(&intent);
    for phase in [
        Phase::StopIntent,
        Phase::Stopped,
        Phase::RemovalIntent,
        Phase::Removed,
    ] {
        let mut receipt = fixture.receipt();
        receipt.phase = phase;
        if receipt.phase == Phase::Removed {
            for resource in receipt.resources.values_mut() {
                resource.phase = "removed".into();
            }
        }
        journal::save(&fixture.journal_root(), &receipt).unwrap();
        let selected = select(&fixture.candidate, RUN).unwrap();
        assert_eq!(selected.receipt.phase, Phase::ReadyObserved);
        assert_eq!(selected.receipt_sha256, original_receipt);
        assert_eq!(selected.owner_sha256, original_owner);
        intent.receipt_progress = receipt_progress(&receipt).unwrap();
        intent.resource_progress = resource_progress(&receipt).unwrap();
        fixture.store(&intent);
    }
    let mut bad = fixture.receipt();
    bad.phase = Phase::RemovalIntent;
    journal::save(&fixture.journal_root(), &bad).unwrap();
    fixture.assert_refused_unchanged();
}

#[test]
fn changed_inventory_and_regressed_resource_progress_refuse_under_original_intent() {
    for case in ["id", "owner", "boot", "resource-regression"] {
        let fixture = Fixture::new();
        fixture.dead();
        let mut intent = fixture.intent();
        let mut current = fixture.receipt();
        current.phase = Phase::RemovalIntent;
        intent.receipt_progress = 3;
        match case {
            "id" => current.resources.get_mut("container:web").unwrap().id = Some("e".repeat(64)),
            "owner" => current.owner = "e".repeat(32),
            "boot" => current.boot = "12345678-abcd-abcd-abcd-223456789abc".into(),
            "resource-regression" => {
                intent.resource_progress.insert("container:web".into(), 2);
            }
            _ => unreachable!(),
        }
        fixture.store(&intent);
        journal::save(&fixture.journal_root(), &current).unwrap();
        fixture.assert_refused_unchanged();
    }
}

#[test]
fn retired_publication_paths_require_prior_exact_phase_and_never_missing_both() {
    let fixture = Fixture::new();
    fixture.dead();
    let mut intent = fixture.intent();
    let mut receipt = fixture.receipt();
    receipt.phase = Phase::Removed;
    for resource in receipt.resources.values_mut() {
        resource.phase = "removed".into();
    }
    journal::save(&fixture.journal_root(), &receipt).unwrap();
    intent.receipt_progress = 4;
    intent.resource_progress = resource_progress(&receipt).unwrap();
    fixture.store(&intent);
    let prefix = &intent.publication.fingerprint()[..24];
    let socket_archive = fixture
        .owner_root()
        .join(format!("control-{prefix}.retired.sock"));
    let owner_archive = fixture
        .owner_root()
        .join(format!("owner-{prefix}.retired.json"));
    fs::rename(fixture.owner_root().join("control.sock"), &socket_archive).unwrap();
    assert!(select(&fixture.candidate, RUN).is_err());
    intent.progress = Progress::SocketRetirementIntent;
    fixture.store(&intent);
    assert!(select(&fixture.candidate, RUN).is_ok());
    intent.progress = Progress::SocketRetired;
    fixture.store(&intent);
    fs::rename(fixture.owner_root().join("owner.json"), &owner_archive).unwrap();
    assert!(select(&fixture.candidate, RUN).is_err());
    intent.progress = Progress::OwnerRetirementIntent;
    fixture.store(&intent);
    assert!(select(&fixture.candidate, RUN).is_ok());
    intent.progress = Progress::Complete;
    fixture.store(&intent);
    let final_selection = select(&fixture.candidate, RUN).unwrap();
    assert_eq!(final_selection.receipt_sha256, intent.receipt_sha256);
    fs::remove_file(socket_archive).unwrap();
    assert!(select(&fixture.candidate, RUN).is_err());
}

fn recovery_options(selected: &Selection) -> Options<'_> {
    Options {
        run: RUN,
        expect_receipt: &selected.receipt_sha256,
        expect_owner: &selected.owner_sha256,
    }
}
fn removed(fixture: &Fixture) -> Receipt {
    let mut receipt = fixture.receipt();
    receipt.phase = Phase::Removed;
    for resource in receipt.resources.values_mut() {
        resource.phase = "removed".into();
    }
    journal::save(&fixture.journal_root(), &receipt).unwrap();
    receipt
}
fn absent_snapshot(receipt: Receipt) -> runtime::Snapshot {
    runtime::Snapshot {
        observations: receipt
            .readiness
            .keys()
            .map(|key| (key.clone(), None))
            .collect(),
        receipt,
    }
}

#[test]
fn effect_recovery_requires_exact_selectors_before_intent_or_driver_entry() {
    let fixture = Fixture::new();
    fixture.dead();
    let selected = select(&fixture.candidate, RUN).unwrap();
    let called = std::cell::Cell::new(0);
    for owner in [false, true] {
        let mut options = recovery_options(&selected);
        let wrong = "f".repeat(64);
        if owner {
            options.expect_owner = &wrong;
        } else {
            options.expect_receipt = &wrong;
        }
        assert!(
            cleanup::recover_using(&fixture.candidate, options, |_, _| {
                called.set(called.get() + 1);
                panic!("wrong original selection cannot reach cleanup")
            })
            .is_err()
        );
        assert!(!fixture.journal_root().join(FILE).exists());
        let again = select(&fixture.candidate, RUN).unwrap();
        assert_eq!(again.receipt_sha256, selected.receipt_sha256);
        assert_eq!(again.owner_sha256, selected.owner_sha256);
    }
    assert_eq!(called.get(), 0);
}

#[test]
fn recovery_commits_original_before_driver_and_archives_only_after_removed_absence() {
    let fixture = Fixture::new();
    fixture.dead();
    let selected = select(&fixture.candidate, RUN).unwrap();
    let lock = id(&fixture.owner_root().join("operation.lock")).unwrap();
    let outcome = cleanup::recover_using(
        &fixture.candidate,
        recovery_options(&selected),
        |context, retired| {
            assert!(!retired);
            let intent: Intent = serde_json::from_slice(
                &native_input::read_file(&fixture.journal_root().join(FILE), LIMIT).unwrap(),
            )
            .unwrap();
            assert_eq!(intent.receipt_sha256, selected.receipt_sha256);
            assert_eq!(intent.publication.fingerprint(), selected.owner_sha256);
            assert!(intent.progress == Progress::Cleanup);
            context.guard()?;
            for phase in [Phase::StopIntent, Phase::Stopped, Phase::RemovalIntent] {
                let mut receipt = fixture.receipt();
                receipt.phase = phase;
                journal::save(&fixture.journal_root(), &receipt)?;
                context.guard()?;
            }
            let receipt = removed(&fixture);
            context.finish_using(&absent_snapshot(receipt.clone()), &|_| Ok(()))?;
            Ok(receipt)
        },
    )
    .unwrap();
    let wire = serde_json::to_value(outcome).unwrap();
    assert_eq!(wire["publication_retired"], true);
    assert_eq!(wire["receipt"]["phase"], "removed");
    assert!(!fixture.owner_root().join("owner.json").exists());
    assert!(!fixture.owner_root().join("control.sock").exists());
    assert_eq!(
        id(&fixture.owner_root().join("operation.lock")).unwrap(),
        lock
    );
    let again = select(&fixture.candidate, RUN).unwrap();
    assert_eq!(again.receipt_sha256, selected.receipt_sha256);
    assert_eq!(again.owner_sha256, selected.owner_sha256);
    assert_eq!(again.receipt.phase, Phase::ReadyObserved);
    let intent = fs::read(fixture.journal_root().join(FILE)).unwrap();
    cleanup::recover_using(
        &fixture.candidate,
        recovery_options(&selected),
        |context, retired| {
            assert!(retired);
            let receipt = fixture.receipt();
            context.finish_using(&absent_snapshot(receipt.clone()), &|_| {
                panic!("complete retry cannot repeat archive")
            })?;
            Ok(receipt)
        },
    )
    .unwrap();
    assert_eq!(fs::read(fixture.journal_root().join(FILE)).unwrap(), intent);
    assert!(!fixture.candidate.state_root.join("run/smolvm").exists());
}

#[test]
fn committed_environment_inventory_refuses_record_loss_or_replacement_before_archives() {
    for case in ["deleted", "same-bytes-new-inode", "changed-metadata"] {
        let fixture = Fixture::new();
        fixture.dead();
        let receipt = fixture.receipt();
        let slot = format!("hack-env-lease-{}-{}", receipt.boot, "a".repeat(32));
        let path = fixture
            .candidate
            .state_root
            .join("run/native-environment-leases")
            .join(format!("{slot}.json"));
        state::private_directory(path.parent().unwrap()).unwrap();
        let metadata = json!({"version":2,"kind":"native-environment-allocation","binding":{
            "namespace":receipt.review.scope().namespace,"run":RUN,"review":receipt.review.review_id(),"container":receipt.resources["container:web"].name
        },"service":"web","uid":0,"gid":0,"slot":slot,"incarnation":receipt.owner,"boot":receipt.boot});
        state::write(&path, &metadata).unwrap();
        let selected = select(&fixture.candidate, RUN).unwrap();
        assert!(
            cleanup::recover_using(
                &fixture.candidate,
                recovery_options(&selected),
                |context, _| {
                    let original = native_input::read_file(&path, 4096)?;
                    let identity = id(&path)?;
                    context.guard()?;
                    let receipt = removed(&fixture);
                    context.guard()?;
                    match case {
                        "deleted" => fs::remove_file(&path).unwrap(),
                        "same-bytes-new-inode" => {
                            fs::rename(&path, fixture.root.join("retained-native-allocation"))
                                .unwrap();
                            let mut replacement = OpenOptions::new()
                                .write(true)
                                .create_new(true)
                                .mode(0o600)
                                .open(&path)
                                .unwrap();
                            replacement.write_all(&original).unwrap();
                            replacement.sync_all().unwrap();
                            assert_ne!(id(&path).unwrap(), identity);
                        }
                        "changed-metadata" => {
                            let mut changed = metadata.clone();
                            changed["uid"] = json!(10);
                            fs::write(&path, changed.to_string()).unwrap();
                        }
                        _ => unreachable!(),
                    }
                    assert!(context.guard().is_err());
                    context.finish_using(&absent_snapshot(receipt.clone()), &|_| {
                        panic!("changed environment inventory cannot retire publication")
                    })?;
                    Ok(receipt)
                }
            )
            .is_err()
        );
        assert!(fixture.owner_root().join("owner.json").exists());
        assert!(fixture.owner_root().join("control.sock").exists());
        let saved: Intent = serde_json::from_slice(
            &native_input::read_file(&fixture.journal_root().join(FILE), LIMIT).unwrap(),
        )
        .unwrap();
        assert!(saved.progress == Progress::Cleanup);
        assert!(select(&fixture.candidate, RUN).is_err());
    }
}

#[test]
fn publication_retirement_interruption_retries_only_prior_exact_phase_and_inventory() {
    for stop in [
        Progress::SocketRetirementIntent,
        Progress::SocketRetired,
        Progress::OwnerRetirementIntent,
    ] {
        let fixture = Fixture::new();
        fixture.dead();
        let selected = select(&fixture.candidate, RUN).unwrap();
        let lock = id(&fixture.owner_root().join("operation.lock")).unwrap();
        assert!(
            cleanup::recover_using(
                &fixture.candidate,
                recovery_options(&selected),
                |context, _| {
                    let receipt = removed(&fixture);
                    context.finish_using(&absent_snapshot(receipt), &|phase| {
                        if phase == stop {
                            Err(refused())
                        } else {
                            Ok(())
                        }
                    })?;
                    panic!("injected durable retirement boundary must interrupt")
                }
            )
            .is_err()
        );
        let before = select(&fixture.candidate, RUN).unwrap();
        assert_eq!(before.receipt_sha256, selected.receipt_sha256);
        cleanup::recover_using(
            &fixture.candidate,
            recovery_options(&selected),
            |context, retired| {
                assert!(retired);
                let receipt = fixture.receipt();
                context.finish_using(&absent_snapshot(receipt.clone()), &|_| Ok(()))?;
                Ok(receipt)
            },
        )
        .unwrap();
        assert_eq!(
            id(&fixture.owner_root().join("operation.lock")).unwrap(),
            lock
        );
        assert!(!fixture.owner_root().join("owner.json").exists());
        assert!(!fixture.owner_root().join("control.sock").exists());
    }
}

#[test]
fn oversized_intent_refuses_before_pending_publication_or_cleanup() {
    let fixture = Fixture::new();
    fixture.dead();
    let path = fixture.journal_root().join("state.json");
    let original = fs::read_to_string(&path).unwrap();
    let padded = format!("{}{}", original, " ".repeat(LIMIT - original.len()));
    fs::write(&path, &padded).unwrap();
    let selected = select(&fixture.candidate, RUN).unwrap();
    let called = std::cell::Cell::new(false);
    assert!(
        cleanup::recover_using(&fixture.candidate, recovery_options(&selected), |_, _| {
            called.set(true);
            panic!("oversized serialized intent cannot reach cleanup")
        })
        .is_err()
    );
    assert!(!called.get());
    assert!(!fixture.journal_root().join(FILE).exists());
    assert!(
        !fixture
            .journal_root()
            .join("live-owner-recovery.pending")
            .exists()
    );
    assert_eq!(fs::read_to_string(path).unwrap(), padded);
}

#[test]
fn fresh_absence_and_unchanged_publication_are_required_before_retirement() {
    for substituted in [false, true] {
        let fixture = Fixture::new();
        fixture.dead();
        let selected = select(&fixture.candidate, RUN).unwrap();
        let owner = fs::read(fixture.owner_root().join("owner.json")).unwrap();
        assert!(
            cleanup::recover_using(
                &fixture.candidate,
                recovery_options(&selected),
                |context, _| {
                    let receipt = removed(&fixture);
                    let mut observed = absent_snapshot(receipt);
                    if !substituted {
                        observed.observations.insert(
                            "web".into(),
                            Some(Observation::Running {
                                health: execution::Health::None,
                            }),
                        );
                    }
                    context.finish_using(&observed, &|phase| {
                        if substituted && phase == Progress::SocketRetirementIntent {
                            let path = fixture.owner_root().join("control.sock");
                            fs::rename(&path, path.with_extension("retained")).unwrap();
                            let _replacement =
                                std::os::unix::net::UnixListener::bind(&path).unwrap();
                            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
                        }
                        Ok(())
                    })?;
                    panic!("unproved absence or substituted socket cannot complete retirement")
                }
            )
            .is_err()
        );
        assert_eq!(
            fs::read(fixture.owner_root().join("owner.json")).unwrap(),
            owner
        );
        assert!(fixture.owner_root().join("control.sock").exists());
        assert!(fixture.journal_root().join(FILE).exists());
        let prefix = &selected.owner_sha256[..24];
        assert!(
            !fixture
                .owner_root()
                .join(format!("owner-{prefix}.retired.json"))
                .exists()
        );
        assert!(
            !fixture
                .owner_root()
                .join(format!("control-{prefix}.retired.sock"))
                .exists()
        );
    }
}
