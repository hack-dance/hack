use super::*;
use crate::{Candidate, project::native::ManagedValues};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, FileTypeExt, PermissionsExt, symlink},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

const NAMESPACE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RUN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
fn scope() -> Scope<'static> {
    Scope {
        namespace: NAMESPACE,
        run: RUN,
    }
}
fn project() -> Value {
    json!({"schema_version":1,"name":"fixture","services":{"web":{"image":"fixture/web:1","command":{"exec":["/bin/echo","authored-canary","$RAW"]},"environment":{"MESSAGE":{"literal":"literal-canary"}}}}})
}
fn request(project: &Value, metadata: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"request_version":1,"project":project.to_string(),"env_metadata":{"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":metadata,"inactive_scopes":[]}})).unwrap()
}
fn prepare_request(bytes: &[u8], values: &ManagedValues) -> Prepared {
    let expected = review(bytes, &[], scope()).unwrap();
    prepare(PrepareOptions {
        compile: CompileOptions {
            request: bytes,
            profiles: &[],
            managed_values: values,
        },
        scope: scope(),
        expected_review: &expected,
        deadline: Instant::now() + Duration::from_secs(120),
    })
    .unwrap()
}
struct Fixture {
    root: PathBuf,
    candidate: Candidate,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "hack-native-input-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let candidate = Candidate::discover(&root).unwrap();
        Self { root, candidate }
    }
    fn path(&self) -> PathBuf {
        storage::directory(&self.candidate, scope())
            .unwrap()
            .join("input.json")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn review_binds_real_compiler_identity_and_exact_project_run_scope() {
    let bytes = request(&project(), json!({"web":{}}));
    let first = review(&bytes, &[], scope()).unwrap();
    let native = native::review(&bytes, &[]).unwrap();
    assert_eq!(first.compiler_identity(), &native);
    for changed in [
        Scope {
            namespace: &"c".repeat(64),
            run: RUN,
        },
        Scope {
            namespace: NAMESPACE,
            run: &"d".repeat(32),
        },
    ] {
        let other = review(&bytes, &[], changed).unwrap();
        assert_ne!(first.review_id(), other.review_id());
        assert_eq!(first.compiler_identity(), other.compiler_identity());
    }
    for changed in [
        Scope {
            namespace: "../namespace",
            run: RUN,
        },
        Scope {
            namespace: NAMESPACE,
            run: "run",
        },
    ] {
        assert!(review(&bytes, &[], changed).is_err());
    }
    let mut profiles = project();
    profiles["profiles"] = json!(["dev"]);
    profiles["services"]["debug"] = json!({"image":"fixture/debug:1","profiles":["dev"]});
    let bytes = request(&profiles, json!({"web":{},"debug":{}}));
    let plain = review(&bytes, &[], scope()).unwrap();
    let selected = review(&bytes, &["dev".into()], scope()).unwrap();
    assert_ne!(plain.review_id(), selected.review_id());
    assert_eq!(selected.compiler_identity().selected_profiles, ["dev"]);
}

#[test]
fn stale_native_input_refuses_before_private_preparation_or_state_effects() {
    let fixture = Fixture::new();
    let bytes = request(&project(), json!({"web":{}}));
    let expected = review(&bytes, &[], scope()).unwrap();
    let mut changed = project();
    changed["services"]["web"]["command"]["exec"][2] = json!("${CHANGED}");
    let changed = request(&changed, json!({"web":{}}));
    let empty = BTreeMap::new();
    let error = prepare(PrepareOptions {
        compile: CompileOptions {
            request: &changed,
            profiles: &[],
            managed_values: &empty,
        },
        scope: scope(),
        expected_review: &expected,
        deadline: Instant::now() + Duration::from_secs(120),
    })
    .err()
    .unwrap();
    assert_eq!(error.code, "native_input_stale");
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("authored-canary")
    );
    assert!(!fixture.candidate.state_root.exists());
    let mut wrong: Value = serde_json::to_value(&expected).unwrap();
    wrong["review_id"] = json!("f".repeat(64));
    let wrong: Review = serde_json::from_value(wrong).unwrap();
    assert!(
        prepare(PrepareOptions {
            compile: CompileOptions {
                request: &bytes,
                profiles: &[],
                managed_values: &empty
            },
            scope: scope(),
            expected_review: &wrong,
            deadline: Instant::now() + Duration::from_secs(120)
        })
        .is_err()
    );
}

#[test]
fn one_ingress_deadline_bounds_prepare_publication_and_transfer_without_renewal() {
    let fixture = Fixture::new();
    let bytes = request(&project(), json!({"web":{}}));
    let expected = review(&bytes, &[], scope()).unwrap();
    let empty = BTreeMap::new();
    for deadline in [
        Instant::now() - Duration::from_secs(1),
        Instant::now() + Duration::from_secs(301),
    ] {
        assert!(
            prepare(PrepareOptions {
                compile: CompileOptions {
                    request: &bytes,
                    profiles: &[],
                    managed_values: &empty
                },
                scope: scope(),
                expected_review: &expected,
                deadline
            })
            .is_err()
        );
    }
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut prepared = prepare(PrepareOptions {
        compile: CompileOptions {
            request: &bytes,
            profiles: &[],
            managed_values: &empty,
        },
        scope: scope(),
        expected_review: &expected,
        deadline,
    })
    .unwrap();
    assert!(prepared.remaining().unwrap() <= deadline);
    prepared.deadline = Deadline::from_instant(Instant::now() + Duration::from_millis(1)).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    assert!(publish(&fixture.candidate, &prepared).is_err());
    assert!(!fixture.candidate.state_root.exists());
    assert!(prepared.into_parts().is_err());
}

#[cfg(feature = "environment-launcher")]
#[test]
fn private_rotation_does_not_reidentify_and_only_pending_delivery_retains_values() {
    let fixture = Fixture::new();
    let bytes = request(
        &project(),
        json!({"web":{"TOKEN":{"scope":"web","secret":true}}}),
    );
    let first_values = BTreeMap::from([(
        "web".into(),
        BTreeMap::from([("TOKEN".into(), "synthetic-private-one".into())]),
    )]);
    let second_values = BTreeMap::from([(
        "web".into(),
        BTreeMap::from([("TOKEN".into(), "synthetic-private-two".into())]),
    )]);
    let first = prepare_request(&bytes, &first_values);
    let second = prepare_request(&bytes, &second_values);
    assert_eq!(first.review(), second.review());
    assert!(first.inputs().managed_environment.is_empty());
    assert_eq!(
        first.inputs().workloads["web"].environment["MESSAGE"],
        "literal-canary"
    );
    let receipt = publish(&fixture.candidate, &first).unwrap();
    let encoded = fs::read_to_string(fixture.path()).unwrap();
    for canary in [
        "synthetic-private",
        "authored-canary",
        "literal-canary",
        "$RAW",
    ] {
        assert!(!encoded.contains(canary));
    }
    assert!(!format!("{receipt:?}").contains("synthetic-private"));
    let (inputs, pending) = first.into_parts().unwrap();
    assert!(inputs.managed_environment.is_empty());
    assert_eq!(pending.len(), 1);
    assert!(pending.contains_key("web"));
}

#[cfg(not(feature = "environment-launcher"))]
#[test]
fn private_preparation_requires_existing_launcher_feature() {
    let bytes = request(
        &project(),
        json!({"web":{"TOKEN":{"scope":"web","secret":true}}}),
    );
    let expected = review(&bytes, &[], scope()).unwrap();
    let values = BTreeMap::from([(
        "web".into(),
        BTreeMap::from([("TOKEN".into(), "synthetic-private".into())]),
    )]);
    let error = prepare(PrepareOptions {
        compile: CompileOptions {
            request: &bytes,
            profiles: &[],
            managed_values: &values,
        },
        scope: scope(),
        expected_review: &expected,
        deadline: Instant::now() + Duration::from_secs(120),
    })
    .err()
    .unwrap();
    assert_eq!(error.code, "environment_launcher_disabled");
}

#[test]
fn distinct_native_artifact_roundtrip_never_overwrites_or_populates_compose_state() {
    let fixture = Fixture::new();
    let bytes = request(&project(), json!({"web":{}}));
    let prepared = prepare_request(&bytes, &BTreeMap::new());
    let receipt = publish(&fixture.candidate, &prepared).unwrap();
    assert_eq!(
        load(&fixture.candidate, scope(), prepared.review()).unwrap(),
        receipt
    );
    let encoded = fs::read(fixture.path()).unwrap();
    let value: Value = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(value["version"], 2);
    assert_eq!(value["kind"], "native-graph-preparation");
    assert_eq!(value["phase"], "prepared");
    assert_eq!(value["review"]["provenance"]["namespace"], NAMESPACE);
    assert_eq!(value["review"]["provenance"]["run"], RUN);
    assert!(!value.to_string().contains("normalized_compose"));
    assert!(!fixture.candidate.state_root.join("run/graphs").exists());
    assert!(!fixture.candidate.state_root.join("run/workspaces").exists());
    assert!(publish(&fixture.candidate, &prepared).is_err());
    assert_eq!(fs::read(fixture.path()).unwrap(), encoded);
    assert!(serde_json::from_slice::<super::super::graph::Receipt>(&encoded).is_err());
}

#[test]
fn native_reader_refuses_missing_stale_unknown_duplicate_and_cross_kind_data() {
    let fixture = Fixture::new();
    let bytes = request(&project(), json!({"web":{}}));
    let prepared = prepare_request(&bytes, &BTreeMap::new());
    assert!(load(&fixture.candidate, scope(), prepared.review()).is_err());
    let receipt = publish(&fixture.candidate, &prepared).unwrap();
    let original = serde_json::to_value(&receipt).unwrap();
    for (pointer, replacement) in [
        ("/version", json!(1)),
        ("/kind", json!("compose")),
        ("/phase", json!("ready")),
        ("/review/provenance/version", json!(2)),
        ("/review/provenance/kind", json!("compose")),
        (
            "/review/provenance/input/semantic_hash",
            json!("e".repeat(64)),
        ),
        (
            "/review/provenance/input/selected_profiles",
            json!(["dev", "dev"]),
        ),
    ] {
        let mut changed = original.clone();
        *changed.pointer_mut(pointer).unwrap() = replacement;
        fs::write(fixture.path(), changed.to_string()).unwrap();
        assert!(load(&fixture.candidate, scope(), prepared.review()).is_err());
    }
    let mut unknown = original.clone();
    unknown["private"] = json!("synthetic-private");
    for malformed in [
        unknown.to_string(),
        "{partial".into(),
        " ".repeat(MAX_ARTIFACT_BYTES + 1),
        serde_json::to_string(&receipt).unwrap().replacen(
            "\"version\":2",
            "\"version\":2,\"version\":2",
            1,
        ),
    ] {
        fs::write(fixture.path(), malformed.as_bytes()).unwrap();
        let error = load(&fixture.candidate, scope(), prepared.review()).unwrap_err();
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("synthetic-private")
        );
        assert_eq!(fs::read(fixture.path()).unwrap(), malformed.as_bytes());
    }
    fs::write(fixture.path(), serde_json::to_vec(&receipt).unwrap()).unwrap();
    fs::write(
        fixture.path().with_extension("pending"),
        b"retained partial",
    )
    .unwrap();
    assert!(load(&fixture.candidate, scope(), prepared.review()).is_err());
    assert_eq!(
        fs::read(fixture.path().with_extension("pending")).unwrap(),
        b"retained partial"
    );
}

#[test]
fn aliased_public_and_fifo_native_receipts_refuse_without_blocking_or_repair() {
    let fixture = Fixture::new();
    let bytes = request(&project(), json!({"web":{}}));
    let prepared = prepare_request(&bytes, &BTreeMap::new());
    publish(&fixture.candidate, &prepared).unwrap();
    let path = fixture.path();
    let backup = path.with_extension("retained");
    fs::rename(&path, &backup).unwrap();
    symlink(&backup, &path).unwrap();
    assert!(load(&fixture.candidate, scope(), prepared.review()).is_err());
    fs::remove_file(&path).unwrap();
    fs::hard_link(&backup, &path).unwrap();
    assert!(load(&fixture.candidate, scope(), prepared.review()).is_err());
    fs::remove_file(&path).unwrap();
    fs::rename(&backup, &path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(load(&fixture.candidate, scope(), prepared.review()).is_err());
    fs::remove_file(&path).unwrap();
    let fifo = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: fifo is a live NUL-terminated path; mkfifo retains no pointer.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let root = fixture.root.clone();
    let expected = prepared.review().clone();
    let (send, receive) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let candidate = Candidate::discover(&root).unwrap();
        send.send(load(&candidate, scope(), &expected).is_err())
            .unwrap();
    });
    assert!(
        receive
            .recv_timeout(Duration::from_secs(1))
            .expect("FIFO open must not block")
    );
    worker.join().unwrap();
    assert!(fs::symlink_metadata(path).unwrap().file_type().is_fifo());
}

#[test]
fn old_compose_v1_receipt_bytes_remain_unchanged() {
    let bytes = format!(
        "{{\"version\":1,\"run\":\"{}\",\"owner\":\"{}\",\"namespace\":\"{}\",\"plan_id\":\"{}\",\"phase\":\"stopped-data-retained\",\"readiness\":{{}},\"resources\":{{}}}}",
        "a".repeat(32),
        "b".repeat(32),
        "c".repeat(64),
        "d".repeat(64)
    );
    let receipt: super::super::graph::Receipt = serde_json::from_str(&bytes).unwrap();
    assert_eq!(serde_json::to_string(&receipt).unwrap(), bytes);
    assert!(serde_json::from_str::<Receipt>(&bytes).is_err());
}

#[test]
fn native_artifact_retention_is_serialized_and_bounded_without_deleting_evidence() {
    let fixture = Fixture::new();
    let bytes = request(&project(), json!({"web":{}}));
    let prepared = prepare_request(&bytes, &BTreeMap::new());
    let root = storage::directory(&fixture.candidate, scope()).unwrap();
    let parent = root.parent().unwrap();
    super::super::state::private_directory(parent).unwrap();
    let lock = super::super::state::Lock::acquire(parent).unwrap();
    assert!(publish(&fixture.candidate, &prepared).is_err());
    drop(lock);
    for index in 0..64 {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(parent.join(format!("{index:032x}")))
            .unwrap();
    }
    assert!(publish(&fixture.candidate, &prepared).is_err());
    assert!(!root.exists());
    assert_eq!(fs::read_dir(parent).unwrap().count(), 65);
}
