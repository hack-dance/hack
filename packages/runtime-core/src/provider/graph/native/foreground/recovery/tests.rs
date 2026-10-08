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
        let metadata: EnvMetadata = serde_json::from_value(json!({
            "metadata_version":1,"overlay":null,"overlay_exists":false,
            "workloads":{"web":{}},"inactive_scopes":[]
        }))
        .unwrap();
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
        .prepare(&self.candidate, &BTreeMap::new())
        .unwrap();
        let config = configuration(prepared.input(), OWNER).unwrap();
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
    assert_eq!(
        selected.host_boot_micros,
        crate::provider::host_filesystem::host_boot_micros().unwrap()
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
                owner.as_object_mut().unwrap().remove("host_boot_micros");
            }
            "wrong-boot" => {
                owner["host_boot_micros"] = json!(owner["host_boot_micros"].as_u64().unwrap() + 1)
            }
            "unknown" => owner["cleanup_authority"] = json!(true),
            _ => unreachable!(),
        }
        fs::write(&path, owner.to_string()).unwrap();
        fixture.assert_refused_unchanged();
    }
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
            // Publication3 carries no original owner-file inode. Its first
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
