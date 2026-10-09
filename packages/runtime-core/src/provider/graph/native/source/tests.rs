use super::*;
use std::{
    os::unix::fs::{DirBuilderExt, PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "native-source-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        fs::write(root.join("package.json"), "{}").unwrap();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(root.join("src"))
            .unwrap();
        fs::write(root.join("src/main.js"), "original source canary").unwrap();
        Self(root)
    }
    fn inputs(&self, source: &str) -> NativeInputs {
        let project = json!({"schema_version":1,"name":"fixture","services":{"web":{"image":format!("sha256:{}", "a".repeat(64)),"mounts":[{"source":source,"target":"/app","access":"read-only"}]}}});
        let request = serde_json::to_vec(&json!({"request_version":1,"project":project.to_string(),"env_metadata":{"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"web":{}},"inactive_scopes":[]}})).unwrap();
        crate::project::native::review_inputs(&request, &[]).unwrap()
    }
    fn selected(&self, source: &str) -> Selection {
        Selection::new(&self.0, &self.inputs(source))
            .unwrap()
            .unwrap()
    }
    fn binding(&self, source: &str) -> Binding {
        let selected = self.selected(source);
        selected
            .bind(&ProjectShareIntent::approve(&self.0, true).unwrap())
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn services() -> BTreeMap<String, Condition> {
    BTreeMap::from([("web".into(), Condition::Started)])
}
fn prepared(source: Option<&str>) -> native_input::Prepared {
    let mut project = json!({"schema_version":1,"name":"fixture","services":{"web":{"image":format!("sha256:{}", "a".repeat(64))}}});
    if let Some(source) = source {
        project["services"]["web"]["mounts"] =
            json!([{"source":source,"target":"/app","access":"read-only"}]);
    }
    let request = serde_json::to_vec(&json!({"request_version":1,"project":project.to_string(),"env_metadata":{"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"web":{}},"inactive_scopes":[]}})).unwrap();
    let namespace = "a".repeat(64);
    let run = "b".repeat(32);
    let scope = native_input::Scope {
        namespace: &namespace,
        run: &run,
    };
    let review = native_input::review(&request, &[], scope).unwrap();
    native_input::prepare(native_input::PrepareOptions {
        compile: crate::project::native::CompileOptions {
            request: &request,
            profiles: &[],
            managed_values: &BTreeMap::new(),
        },
        scope,
        expected_review: &review,
        deadline: std::time::Instant::now() + Duration::from_secs(60),
    })
    .unwrap()
}

#[test]
fn source_lowering_requires_exact_binding_and_versions_do_not_widen_image_only_receipts() {
    let fixture = Fixture::new();
    let input = prepared(Some("src"));
    assert!(configuration(&input, &"c".repeat(32)).is_err());
    let binding = fixture.binding("src");
    let config = configuration_with_source(&input, &"c".repeat(32), Some(binding.clone())).unwrap();
    assert_eq!(
        config.containers()["web"]["HostConfig"]["Mounts"],
        json!([binding.config("web").unwrap()])
    );
    let receipt = Receipt::preparing(
        &config,
        &"c".repeat(32),
        "12345678-abcd-abcd-abcd-123456789abc",
    )
    .unwrap();
    let encoded = serde_json::to_value(&receipt).unwrap();
    assert_eq!(encoded["version"], 3);
    for (field, value) in [("version", json!(2)), ("source", Value::Null)] {
        let mut bad = encoded.clone();
        bad[field] = value;
        if let Ok(decoded) = serde_json::from_value::<Receipt>(bad) {
            assert!(decoded.validate(&"b".repeat(32), &"c".repeat(32)).is_err());
        }
    }
    let old = configuration(&prepared(None), &"c".repeat(32)).unwrap();
    let old = Receipt::preparing(
        &old,
        &"c".repeat(32),
        "12345678-abcd-abcd-abcd-123456789abc",
    )
    .unwrap();
    let mut old_bytes = serde_json::to_value(&old).unwrap();
    assert_eq!(old_bytes["version"], 2);
    assert!(old_bytes.get("source").is_none());
    old_bytes["source"] = Value::Null;
    assert!(serde_json::from_value::<Receipt>(old_bytes).is_err());
    let mut replaced = receipt.clone();
    replaced
        .source
        .as_mut()
        .unwrap()
        .anchors
        .get_mut("src")
        .unwrap()
        .inode += 1;
    assert!(replaced.check_binding(&receipt).is_err());
}

#[test]
fn live_directory_content_and_descendant_edits_are_not_snapshot_drift() {
    let fixture = Fixture::new();
    let selected = fixture.selected("src");
    fs::write(fixture.0.join("src/main.js"), "edited live bytes").unwrap();
    fs::write(fixture.0.join("src/replacement"), "atomic editor").unwrap();
    fs::rename(
        fixture.0.join("src/replacement"),
        fixture.0.join("src/main.js"),
    )
    .unwrap();
    fs::create_dir(fixture.0.join("src/new")).unwrap();
    fs::write(fixture.0.join("src/new/file"), "new content").unwrap();
    selected.verify().unwrap();
    fs::remove_dir_all(fixture.0.join("src/new")).unwrap();
    selected.verify().unwrap();
}

#[test]
fn live_regular_file_allows_in_place_bytes_but_refuses_replaced_inode_or_hardlink() {
    let fixture = Fixture::new();
    let selected = fixture.selected("src/main.js");
    fs::write(fixture.0.join("src/main.js"), "a different length").unwrap();
    selected.verify().unwrap();
    fs::hard_link(fixture.0.join("src/main.js"), fixture.0.join("other")).unwrap();
    assert_eq!(selected.verify().unwrap_err().code, "native_graph_source");
    fs::remove_file(fixture.0.join("other")).unwrap();
    fs::write(fixture.0.join("replacement"), "new selected inode").unwrap();
    fs::rename(fixture.0.join("replacement"), fixture.0.join("src/main.js")).unwrap();
    assert_eq!(selected.verify().unwrap_err().code, "native_graph_source");
}

#[test]
fn selected_directory_alias_incarnation_and_permission_changes_refuse() {
    for case in 0..3 {
        let fixture = Fixture::new();
        let selected = fixture.selected("src");
        match case {
            0 => {
                fs::rename(fixture.0.join("src"), fixture.0.join("old")).unwrap();
                symlink("old", fixture.0.join("src")).unwrap();
            }
            1 => {
                fs::rename(fixture.0.join("src"), fixture.0.join("old")).unwrap();
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(fixture.0.join("src"))
                    .unwrap();
            }
            _ => fs::set_permissions(fixture.0.join("src"), fs::Permissions::from_mode(0o755))
                .unwrap(),
        }
        assert_eq!(selected.verify().unwrap_err().code, "native_graph_source");
    }
}

#[test]
fn source_binding_is_closed_to_exact_paths_policy_and_owned_permissions() {
    let fixture = Fixture::new();
    let good = fixture.binding("src/main.js");
    good.validate(&services()).unwrap();
    for case in 0..6 {
        let mut bad = good.clone();
        match case {
            0 => bad.policy = "immutable".into(),
            1 => bad.version = 2,
            2 => bad.share.inode += 1,
            3 => {
                bad.anchors.remove("src");
            }
            4 => bad.anchors.get_mut("src").unwrap().mode |= 0o002,
            _ => {
                bad.anchors.insert("extra".into(), bad.anchors["."].clone());
            }
        }
        assert!(bad.validate(&services()).is_err());
    }
    let mut encoded = serde_json::to_value(&good).unwrap();
    encoded["mounts"]["web"]["access"] = json!("read-write");
    assert!(serde_json::from_value::<Binding>(encoded).is_err());
}

#[test]
fn exact_guest_bind_is_read_only_rprivate_and_cannot_follow_changed_selection() {
    let fixture = Fixture::new();
    let binding = fixture.binding("src");
    let config = binding.config("web").unwrap();
    let value = json!({"HostConfig":{"Mounts":[config]},"Mounts":[{"Type":"bind","Source":binding.path("web").unwrap(),"Destination":"/app","RW":false,"Propagation":"rprivate"}]});
    binding.verify_container("web", &value).unwrap();
    for (pointer, replacement) in [
        ("/Mounts/0/RW", json!(true)),
        ("/Mounts/0/Source", json!("/other")),
        ("/Mounts/0/Propagation", json!("rshared")),
        ("/HostConfig/Mounts/0/ReadOnly", json!(false)),
    ] {
        let mut bad = value.clone();
        *bad.pointer_mut(pointer).unwrap() = replacement;
        assert!(binding.verify_container("web", &bad).is_err());
    }
    fs::rename(fixture.0.join("src"), fixture.0.join("moved")).unwrap();
    assert!(binding.verify_host().is_err());
    // Original stored identity and exact RO mount remain usable for cleanup;
    // no new host path or source publication is adopted.
    binding.validate(&services()).unwrap();
    binding.verify_container("web", &value).unwrap();
}

#[test]
fn created_container_requires_the_configured_bind_and_later_states_require_runtime_mount() {
    let fixture = Fixture::new();
    let binding = fixture.binding("src");
    let value = json!({"State":{"Status":"created","Running":false},"Mounts":[],"HostConfig":{"Mounts":[binding.config("web").unwrap()]}});
    binding.verify_container("web", &value).unwrap();
    for (pointer, replacement) in [
        ("/State/Status", json!("exited")),
        ("/State/Running", json!(true)),
        ("/HostConfig/Mounts/0/ReadOnly", json!(false)),
        ("/HostConfig/Mounts/0/Source", json!("/foreign")),
        (
            "/Mounts",
            json!([{"Destination":"/app","Type":"bind","Source":"/foreign","RW":false,"Propagation":"rprivate"}]),
        ),
    ] {
        let mut bad = value.clone();
        *bad.pointer_mut(pointer).unwrap() = replacement;
        assert!(binding.verify_container("web", &bad).is_err());
    }
}

#[test]
fn selected_credential_path_and_unsafe_directory_are_not_shared_implicitly() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join(".aws")).unwrap();
    fs::write(fixture.0.join(".aws/key"), "synthetic credential canary").unwrap();
    assert!(Selection::new(&fixture.0, &fixture.inputs(".aws/key")).is_err());
    fs::set_permissions(fixture.0.join("src"), fs::Permissions::from_mode(0o777)).unwrap();
    assert!(Selection::new(&fixture.0, &fixture.inputs("src")).is_err());
}
