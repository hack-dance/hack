use super::*;
use crate::provider::state;
use hack_config_compiler::environment::EnvMetadata;
use std::{
    fs,
    os::unix::{
        fs::{DirBuilderExt, PermissionsExt, symlink},
        net::UnixListener,
    },
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};

const RUN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
struct Fixture {
    root: PathBuf,
    project: PathBuf,
    candidate: Candidate,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "native-foreground-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let project = root.join("project");
        let home = root.join("home");
        for path in [&project, &project.join(".hack"), &home] {
            fs::DirBuilder::new().mode(0o700).create(path).unwrap();
        }
        fs::write(project.join(".hack/hack.project.json"), json!({
            "schema_version":1, "name":"fixture", "services":{"web":{
                "image":format!("sha256:{}", "d".repeat(64)), "command":{"exec":["/bin/echo","$EXACT"]}
            }}
        }).to_string()).unwrap();
        Self {
            root,
            project,
            candidate: Candidate::discover(&home).unwrap(),
        }
    }
    fn prepared(&self) -> selection::Prepared {
        let metadata: EnvMetadata = serde_json::from_value(json!({
            "metadata_version":1, "overlay":null, "overlay_exists":false,
            "workloads":{"web":{}}, "inactive_scopes":[]
        }))
        .unwrap();
        selection::select(
            &self.candidate,
            selection::Options {
                project: &self.project,
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
        .unwrap()
    }
    fn receipt(&self) -> Receipt {
        let prepared = self.prepared();
        let config = configuration(prepared.input(), &"c".repeat(32)).unwrap();
        Receipt::preparing(
            &config,
            &"c".repeat(32),
            "12345678-abcd-abcd-abcd-123456789abc",
        )
        .unwrap()
    }
    fn owner_root(&self) -> PathBuf {
        owner::root(&self.candidate, RUN).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.owner_root().exists() {
            fs::remove_dir_all(self.owner_root()).unwrap();
        }
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn status(receipt: Receipt) -> Reply {
    let observations = receipt
        .readiness
        .keys()
        .map(|key| (key.clone(), None))
        .collect();
    Reply {
        version: 2,
        kind: ReplyKind::NativeGraphControlReply,
        run: RUN.into(),
        review: receipt.review.review_id().into(),
        result: Outcome::Status {
            snapshot: Snapshot {
                receipt,
                observations,
            },
        },
    }
}

#[test]
fn real_compiler_review_crosses_authenticated_native_socket_without_compose_fields() {
    let fixture = Fixture::new();
    let receipt = fixture.receipt();
    let mut publication = owner::Publication::bind(&fixture.candidate, &receipt.review).unwrap();
    journal::reserve(&fixture.candidate, &receipt).unwrap();
    assert!(owner::present(&fixture.candidate, RUN).unwrap());
    std::thread::scope(|scope| {
        let caller = scope.spawn(|| {
            request(
                &fixture.candidate,
                RequestOptions {
                    run: RUN,
                    action: Action::Status,
                },
            )
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut stream = loop {
            if let Some(stream) = publication.accept().unwrap() {
                break stream;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        };
        let input: Request = transport::read(&mut stream, Duration::from_secs(1), 4096).unwrap();
        input.validate(&receipt.review).unwrap();
        assert!(matches!(input.action, Action::Status));
        transport::write(
            &mut stream,
            &status(receipt.clone()),
            Duration::from_secs(1),
        )
        .unwrap();
        let reply = caller.join().unwrap().unwrap();
        assert_eq!(reply["version"], 2);
        assert_eq!(reply["kind"], "native-graph-control-reply");
        assert_eq!(reply["result"]["outcome"], "status");
        assert!(reply.get("planId").is_none());
    });
    publication.finish().unwrap();
    assert!(!owner::present(&fixture.candidate, RUN).unwrap());
}

#[test]
fn native_requests_and_replies_refuse_wrong_kind_version_scope_and_unknown_fields() {
    let fixture = Fixture::new();
    let receipt = fixture.receipt();
    let encoded = json!({"version":2,"kind":"native-graph-control","run":RUN,
        "review":receipt.review.review_id(),"action":"status"});
    for (field, value) in [
        ("kind", json!("graph-control")),
        ("action", json!("exec")),
        ("plan_id", json!("foreign")),
    ] {
        let mut bad = encoded.clone();
        bad[field] = value;
        assert!(serde_json::from_value::<Request>(bad).is_err());
    }
    for (field, value) in [
        ("version", json!(1)),
        ("run", json!("a".repeat(32))),
        ("review", json!("e".repeat(64))),
    ] {
        let mut bad = encoded.clone();
        bad[field] = value;
        assert!(
            serde_json::from_value::<Request>(bad)
                .unwrap()
                .validate(&receipt.review)
                .is_err()
        );
    }
    let reply = status(receipt.clone());
    reply.validate(&receipt).unwrap();
    let encoded = serde_json::to_value(reply).unwrap();
    for (field, value) in [
        ("kind", json!("graph-control-reply")),
        ("values", json!("private-canary")),
    ] {
        let mut bad = encoded.clone();
        bad[field] = value;
        assert!(serde_json::from_value::<Reply>(bad).is_err());
    }
    let mut bad = encoded.clone();
    bad["result"]["snapshot"]["observations"]["web"] =
        json!({"state":"created","extra":"private-canary"});
    assert!(serde_json::from_value::<Reply>(bad).is_err());
    let mut bad = encoded.clone();
    bad["result"]["snapshot"]["observations"]["web"] =
        json!({"state":"running","health":"healthy"});
    serde_json::from_value::<Reply>(bad)
        .unwrap()
        .validate(&receipt)
        .unwrap();
    for (pointer, value) in [
        ("/version", json!(1)),
        ("/review", json!("e".repeat(64))),
        ("/result/snapshot/observations", json!({})),
        ("/result/snapshot/receipt/version", json!(1)),
    ] {
        let mut bad = encoded.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        assert!(
            serde_json::from_value::<Reply>(bad)
                .unwrap()
                .validate(&receipt)
                .is_err()
        );
    }
    let mut cleaned = Reply {
        version: 2,
        kind: ReplyKind::NativeGraphControlReply,
        run: RUN.into(),
        review: receipt.review.review_id().into(),
        result: Outcome::Cleaned {
            receipt: receipt.clone(),
        },
    };
    assert!(cleaned.validate(&receipt).is_err());
    if let Outcome::Cleaned { receipt } = &mut cleaned.result {
        receipt.phase = Phase::Removed;
        for resource in receipt.resources.values_mut() {
            resource.phase = "removed".into();
        }
    }
    cleaned.validate(&receipt).unwrap();
}

#[test]
fn native_stop_details_require_the_exact_journal_membership_and_closed_stage() {
    let fixture = Fixture::new();
    let receipt = fixture.receipt();
    journal::reserve(&fixture.candidate, &receipt).unwrap();
    journal::read_control(&fixture.candidate, &receipt.review).unwrap();
    let encoded = json!({
        "version":2,"kind":"native-graph-control-reply","run":RUN,"review":receipt.review.review_id(),
        "result":{"outcome":"refused","code":"engine_protocol","stop_failures":{
            "version":1,"failures":[{"service":"web","stage":"timeout"}]
        }}
    });
    let reply: Reply = serde_json::from_value(encoded.clone()).unwrap();
    reply.validate(&receipt).unwrap();
    for (pointer, value) in [
        ("/result/code", json!("native_graph_foreground")),
        ("/result/stop_failures/failures/0/service", json!("foreign")),
        (
            "/result/stop_failures/failures/0/service",
            json!("a".repeat(64)),
        ),
        (
            "/result/stop_failures/failures",
            json!([
                {"service":"web","stage":"timeout"},{"service":"web","stage":"response"}
            ]),
        ),
    ] {
        let mut bad = encoded.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        assert!(
            serde_json::from_value::<Reply>(bad)
                .unwrap()
                .validate(&receipt)
                .is_err(),
            "{pointer}"
        );
    }
    let mut bad = encoded;
    bad["result"]["stop_failures"]["failures"][0]["stage"] = json!("private-error");
    assert!(serde_json::from_value::<Reply>(bad).is_err());
    let path = journal::directory(&fixture.candidate, RUN).unwrap();
    state::write(&path.join("state.pending"), &receipt).unwrap();
    assert!(journal::read_control(&fixture.candidate, &receipt.review).is_err());
    assert!(!fixture.candidate.state_root.join("run/smolvm").exists());
}

#[test]
fn owner_codec_refuses_legacy_kind_unknown_fields_and_wrong_process_incarnation() {
    for (pointer, value) in [
        ("/version", json!(1)),
        ("/kind", json!("compose")),
        ("/candidate", json!("/foreign")),
        ("/process/start_micros", json!(0)),
        ("/process/pid", json!(2_000_000)),
        ("/values", json!("private-canary")),
    ] {
        let fixture = Fixture::new();
        let review = fixture.receipt().review;
        let publication = owner::Publication::bind(&fixture.candidate, &review).unwrap();
        let file = fixture.owner_root().join("owner.json");
        let mut bad: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        if pointer == "/values" {
            bad["values"] = value;
        } else {
            *bad.pointer_mut(pointer).unwrap() = value;
        }
        fs::write(&file, serde_json::to_vec(&bad).unwrap()).unwrap();
        assert!(
            owner::Pin::load(&fixture.candidate, RUN).is_err(),
            "{pointer}"
        );
        assert!(publication.verify().is_err(), "{pointer}");
        assert!(DirectGuard::acquire(&fixture.candidate, RUN).is_err());
        assert!(file.exists());
    }
}

#[test]
fn replaced_symlinked_hardlinked_and_public_owner_files_are_not_adopted() {
    for kind in ["replaced", "symlink", "hardlink", "public"] {
        let fixture = Fixture::new();
        let review = fixture.receipt().review;
        let publication = owner::Publication::bind(&fixture.candidate, &review).unwrap();
        let root = fixture.owner_root();
        let file = root.join("owner.json");
        let bytes = fs::read(&file).unwrap();
        match kind {
            "replaced" => {
                fs::rename(&file, root.join("original.json")).unwrap();
                fs::write(&file, &bytes).unwrap();
                fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
            }
            "symlink" => {
                fs::rename(&file, root.join("original.json")).unwrap();
                symlink(root.join("original.json"), &file).unwrap();
            }
            "hardlink" => fs::hard_link(&file, root.join("extra.json")).unwrap(),
            "public" => fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap(),
            _ => unreachable!(),
        }
        assert!(publication.verify().is_err(), "{kind}");
        if kind != "replaced" {
            assert!(owner::Pin::load(&fixture.candidate, RUN).is_err(), "{kind}");
        }
        assert!(file.symlink_metadata().is_ok());
    }
}

#[test]
fn replaced_socket_lock_and_parent_identity_refuse_without_cleanup() {
    for kind in ["socket", "lock", "parent"] {
        let fixture = Fixture::new();
        let review = fixture.receipt().review;
        let publication = owner::Publication::bind(&fixture.candidate, &review).unwrap();
        let root = fixture.owner_root();
        match kind {
            "socket" => {
                fs::rename(root.join("control.sock"), root.join("old.sock")).unwrap();
                let _replacement = UnixListener::bind(root.join("control.sock")).unwrap();
                fs::set_permissions(root.join("control.sock"), fs::Permissions::from_mode(0o600))
                    .unwrap();
            }
            "lock" => {
                fs::rename(root.join("operation.lock"), root.join("old.lock")).unwrap();
                let _replacement = state::Lock::acquire(&root).unwrap();
            }
            "parent" => {
                let saved = fixture.root.join("saved-owner");
                fs::rename(&root, &saved).unwrap();
                fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(publication.verify().is_err(), "{kind}");
        assert!(owner::Pin::load(&fixture.candidate, RUN).is_err(), "{kind}");
        assert!(root.exists());
    }
}

#[test]
fn direct_operations_and_foreground_publication_exclude_each_other_before_provider_effects() {
    let fixture = Fixture::new();
    let review = fixture.receipt().review;
    let direct = DirectGuard::acquire(&fixture.candidate, RUN).unwrap();
    assert!(owner::Publication::bind(&fixture.candidate, &review).is_err());
    assert!(DirectGuard::acquire(&fixture.candidate, RUN).is_err());
    direct.verify().unwrap();
    drop(direct);
    let mut publication = owner::Publication::bind(&fixture.candidate, &review).unwrap();
    assert!(run(&fixture.candidate, fixture.prepared()).is_err());
    assert!(cleanup(&fixture.candidate, RUN).is_err());
    assert!(!fixture.candidate.state_root.join("run/smolvm").exists());
    assert!(
        !journal::directory(&fixture.candidate, RUN)
            .unwrap()
            .exists()
    );
    publication.finish().unwrap();
}

#[test]
fn publication_respects_shared_gate_and_existing_native_reservation() {
    let fixture = Fixture::new();
    let receipt = fixture.receipt();
    let gate = super::super::super::publication_gate::Guard::acquire(&fixture.candidate).unwrap();
    assert!(owner::Publication::bind(&fixture.candidate, &receipt.review).is_err());
    assert!(!fixture.owner_root().exists());
    drop(gate);
    journal::reserve(&fixture.candidate, &receipt).unwrap();
    assert!(owner::Publication::bind(&fixture.candidate, &receipt.review).is_err());
    assert!(!fixture.owner_root().exists());
}

#[test]
fn abandoned_publication_is_evidence_and_never_implicit_recovery_authority() {
    let fixture = Fixture::new();
    let review = fixture.receipt().review;
    let publication = owner::Publication::bind(&fixture.candidate, &review).unwrap();
    drop(publication);
    assert!(owner::present(&fixture.candidate, RUN).unwrap());
    assert!(owner::Publication::bind(&fixture.candidate, &review).is_err());
    assert!(DirectGuard::acquire(&fixture.candidate, RUN).is_err());
    let pin = owner::Pin::load(&fixture.candidate, RUN).unwrap();
    assert!(pin.connect().is_err());
    assert!(fixture.owner_root().join("owner.json").exists());
}

#[test]
fn direct_operation_guard_refuses_replaced_lock_path() {
    let fixture = Fixture::new();
    let direct = DirectGuard::acquire(&fixture.candidate, RUN).unwrap();
    let root = fixture.owner_root();
    fs::rename(root.join("operation.lock"), root.join("old.lock")).unwrap();
    let _replacement = state::Lock::acquire(&root).unwrap();
    assert!(direct.verify().is_err());
    assert!(root.join("old.lock").exists());
}
