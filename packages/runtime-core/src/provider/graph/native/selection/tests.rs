use super::*;
use serde_json::{Value, json};
use std::{
    os::unix::fs::{DirBuilderExt, FileTypeExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

struct Fixture {
    root: PathBuf,
    project: PathBuf,
    candidate: Candidate,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-native-selection-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let home = root.join("home");
        let project = root.join("project");
        for path in [&home, &project, &project.join(".hack")] {
            fs::DirBuilder::new().mode(0o700).create(path).unwrap();
        }
        let candidate = Candidate::discover(&home).unwrap();
        let fixture = Self {
            root,
            project,
            candidate,
        };
        fixture.write_project(basic());
        fixture
    }
    fn marker(&self) -> PathBuf {
        self.project.join(".hack/hack.project.json")
    }
    fn write_project(&self, value: Value) {
        fs::write(self.marker(), value.to_string()).unwrap();
    }
    fn options(&self) -> Options<'_> {
        Options {
            project: &self.project,
            branch: Some("feature-one"),
            run: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            profiles: &[],
            explicit_overlay: None,
            metadata: metadata(json!({"web":{}})),
            deadline: Instant::now() + Duration::from_secs(60),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn basic() -> Value {
    json!({"schema_version":1,"name":"fixture","services":{"web":{"image":format!("sha256:{}","a".repeat(64)),"command":{"exec":["/bin/echo","authored-canary","$RAW"]}}}})
}

#[test]
fn tagged_source_wire_is_disjoint_and_its_snapshot_remains_bound_before_preparation() {
    let fixture = Fixture::new();
    let path = fixture.root.join("source.json");
    let valid = json!({"version":2,"kind":"native-graph-source","project":fixture.project,"branch":"feature-one","run":"b".repeat(32),"profiles":[],"overlay":"inherit","env_metadata":{"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"web":{}},"inactive_scopes":[]}});
    fs::write(&path, valid.to_string()).unwrap();
    let selected = Source::read(&path)
        .unwrap()
        .select(&fixture.candidate, fixture.options().deadline)
        .unwrap();
    let direct = select(&fixture.candidate, fixture.options()).unwrap();
    assert_eq!(selected.review().review_id(), direct.review().review_id());
    fs::write(&path, format!("{valid}\n")).unwrap();
    selection_refused(selected.prepare(&fixture.candidate, &native::ManagedValues::new()));
    for (key, value) in [
        ("version", json!(1)),
        ("kind", json!("normalized-compose")),
        ("normalized_compose_sha256", json!("c".repeat(64))),
        ("values", json!("synthetic-private")),
        ("overlay", Value::Null),
    ] {
        let mut bad = valid.clone();
        bad[key] = value;
        fs::write(&path, bad.to_string()).unwrap();
        selection_refused(Source::read(&path));
    }
}
fn metadata(workloads: Value) -> EnvMetadata {
    serde_json::from_value(json!({"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":workloads,"inactive_scopes":[]})).unwrap()
}
fn selection_refused<T>(result: Result<T, CandidateError>) {
    let error = result.err().expect("expected selection refusal");
    assert_eq!(error.code, "native_graph_selection");
    let output = serde_json::to_string(&error).unwrap();
    assert!(!output.contains("authored-canary"));
    assert!(!output.contains("synthetic-private"));
}

#[test]
fn exact_native_files_bind_candidate_namespace_and_delivered_process_without_state() {
    let fixture = Fixture::new();
    let options = fixture.options();
    let deadline = options.deadline;
    let selected = select(&fixture.candidate, options).unwrap();
    assert_eq!(
        selected.review().scope().namespace,
        fixture
            .candidate
            .plan_with_branch(&fixture.project, Some("feature-one"))
            .unwrap()
            .namespace
    );
    assert_eq!(selected.project_root(), fixture.project);
    assert!(selected.remaining().unwrap() <= deadline);
    let prepared = selected
        .prepare(&fixture.candidate, &native::ManagedValues::new())
        .unwrap();
    prepared.assert_fresh(&fixture.candidate).unwrap();
    let configured =
        super::super::configuration(prepared.input(), "cccccccccccccccccccccccccccccccc").unwrap();
    assert_eq!(
        configured.containers()["web"]["Cmd"],
        json!(["/bin/echo", "authored-canary", "$RAW"])
    );
    assert!(prepared.remaining().unwrap() <= deadline);
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn changed_authored_document_new_local_or_legacy_family_refuse_before_private_preparation() {
    for case in 0..3 {
        let fixture = Fixture::new();
        let mut options = fixture.options();
        options.metadata = metadata(json!({"web":{"TOKEN":{"scope":"web","secret":true}}}));
        let selected = select(&fixture.candidate, options).unwrap();
        match case {
            0 => {
                let mut value = basic();
                value["services"]["web"]["command"] = json!({"exec":["/bin/false"]});
                fixture.write_project(value);
            }
            1 => fs::write(
                fixture.project.join(".hack/hack.local.json"),
                "{\"schema_version\":1,\"environment\":{\"default_overlay\":null}}",
            )
            .unwrap(),
            _ => fs::write(
                fixture.project.join(".hack/docker-compose.yml"),
                "services: {}",
            )
            .unwrap(),
        }
        // Missing caller-private values would fail compilation if acquisition
        // freshness did not refuse first. No copied values or pending handle exists.
        selection_refused(selected.prepare(&fixture.candidate, &native::ManagedValues::new()));
        assert!(!fixture.candidate.state_root.exists());
    }
}

#[test]
fn branch_profile_and_checkout_local_selection_are_compiler_owned() {
    let fixture = Fixture::new();
    let mut value = basic();
    value["profiles"] = json!(["debug"]);
    value["jobs"] = json!({"debug":{"image":format!("sha256:{}","a".repeat(64)),"profiles":["debug"],"command":{"exec":["/bin/true"]}}});
    fixture.write_project(value);
    let mut plain = fixture.options();
    plain.metadata = metadata(json!({"web":{},"debug":{}}));
    let plain = select(&fixture.candidate, plain).unwrap();
    let profiles = ["debug".into()];
    let mut active = fixture.options();
    active.profiles = &profiles;
    active.metadata = metadata(json!({"web":{},"debug":{}}));
    let active = select(&fixture.candidate, active).unwrap();
    assert_eq!(
        active.review().compiler_identity().selected_profiles,
        ["debug"]
    );
    assert_ne!(plain.review().review_id(), active.review().review_id());
    let mut branch = fixture.options();
    branch.branch = Some("feature-two");
    branch.metadata = metadata(json!({"web":{},"debug":{}}));
    assert_ne!(
        plain.review().review_id(),
        select(&fixture.candidate, branch)
            .unwrap()
            .review()
            .review_id()
    );
    fs::write(
        fixture.project.join(".hack/hack.local.json"),
        "{\"schema_version\":1,\"environment\":{\"default_overlay\":null}}",
    )
    .unwrap();
    let mut local = fixture.options();
    local.metadata = metadata(json!({"web":{},"debug":{}}));
    let local = select(&fixture.candidate, local).unwrap();
    assert_ne!(
        plain.review().compiler_identity().local_resolution_hash,
        local.review().compiler_identity().local_resolution_hash
    );
}

#[test]
fn inherited_linked_worktree_inputs_refuse_without_interpreting_git_or_primary_paths() {
    let fixture = Fixture::new();
    fs::write(
        fixture.project.join(".git"),
        "gitdir: /synthetic-private-unused",
    )
    .unwrap();
    selection_refused(select(&fixture.candidate, fixture.options()));
    let mut value = basic();
    value["worktree"] = json!({"inherit_local":false});
    fixture.write_project(value);
    let selected = select(&fixture.candidate, fixture.options()).unwrap();
    selected.assert_fresh(&fixture.candidate).unwrap();
    fs::write(fixture.project.join(".git"), "gitdir: /changed-unused").unwrap();
    selection_refused(selected.assert_fresh(&fixture.candidate));
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn marker_aliases_unsafe_types_oversize_and_directories_refuse_without_repair() {
    for case in 0..6 {
        let fixture = Fixture::new();
        let marker = fixture.marker();
        let original = fixture.root.join("original.json");
        fs::rename(&marker, &original).unwrap();
        match case {
            0 => symlink(&original, &marker).unwrap(),
            1 => fs::hard_link(&original, &marker).unwrap(),
            2 => {
                fs::DirBuilder::new().mode(0o700).create(&marker).unwrap();
            }
            3 => {
                fs::write(&marker, vec![b' '; LIMIT + 1]).unwrap();
            }
            4 => {
                let hacked = fixture.root.join("hacked");
                fs::rename(fixture.project.join(".hack"), &hacked).unwrap();
                symlink(&hacked, fixture.project.join(".hack")).unwrap();
            }
            _ => {}
        }
        selection_refused(select(&fixture.candidate, fixture.options()));
        assert!(original.exists());
        assert!(!fixture.candidate.state_root.exists());
    }
}

#[test]
fn selection_cannot_transfer_candidate_or_extend_ingress_deadline() {
    let fixture = Fixture::new();
    for delta in [Duration::ZERO, Duration::from_secs(301)] {
        let mut options = fixture.options();
        options.deadline = Instant::now() + delta;
        assert_eq!(
            select(&fixture.candidate, options).err().unwrap().code,
            "private_deadline_refused"
        );
    }
    let selected = select(&fixture.candidate, fixture.options()).unwrap();
    let other = Fixture::new();
    selection_refused(selected.assert_fresh(&other.candidate));
    let mut selected = select(&fixture.candidate, fixture.options()).unwrap();
    // Compare the stored same-clock deadline. Separate conservative conversions
    // to Instant deduct different sampling intervals and need not be equal.
    let original = selected.deadline.nanos();
    selected
        .restrict_deadline(Instant::now() + Duration::from_secs(120))
        .unwrap();
    assert!(selected.deadline.nanos() <= original);
    let shorter = Instant::now() + Duration::from_millis(100);
    selected.restrict_deadline(shorter).unwrap();
    assert!(selected.remaining().unwrap() <= shorter);
    std::thread::sleep(Duration::from_millis(120));
    assert_eq!(
        selected
            .prepare(&fixture.candidate, &native::ManagedValues::new())
            .err()
            .unwrap()
            .code,
        "private_deadline_refused"
    );
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn run_profile_bounds_and_nonblocking_fifo_controls_refuse() {
    let fixture = Fixture::new();
    let mut options = fixture.options();
    options.run = "../../escape";
    selection_refused(select(&fixture.candidate, options));
    let profiles = vec!["debug".into(); 65];
    let mut options = fixture.options();
    options.profiles = &profiles;
    selection_refused(select(&fixture.candidate, options));
    let marker = fixture.marker();
    fs::remove_file(&marker).unwrap();
    let path = std::ffi::CString::new(marker.as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: path is a live NUL-terminated CString and mode has no pointer requirements.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    selection_refused(select(&fixture.candidate, fixture.options()));
    assert!(fs::symlink_metadata(&marker).unwrap().file_type().is_fifo());
    assert!(!fixture.candidate.state_root.exists());
}

#[test]
fn frontend_hook_permit_is_versioned_scoped_and_rechecked_without_normal_graph_bypass() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let mut project = basic();
    project["host"] = json!({"up":{"before":[{"name":"prepare","command":{"exec":["true"]}}]}});
    fixture.write_project(project);
    let root = fixture.project.join(".hack/.internal/native-authored-runs");
    fs::create_dir_all(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let run = "b".repeat(32);
    let branch = Some("feature-one");
    let key = format!("{:x}", Sha256::digest(serde_json::to_vec(&branch).unwrap()));
    let private = |path: &Path, value: Value| {
        fs::write(path, value.to_string()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        let meta = fs::symlink_metadata(path).unwrap();
        json!({"path":path,"dev":meta.dev(),"ino":meta.ino(),"sha256":format!("{:x}",Sha256::digest(value.to_string().as_bytes()))})
    };
    let owner = private(
        &root.join(format!("{key}.hooks.json")),
        json!({"version":1,"kind":"native-authored-hook-owner","run":run,"project":fixture.project,"branch":branch,"selection":"a".repeat(64),"pid":unsafe{libc::getppid()},"uid":unsafe{libc::getuid()}}),
    );
    let path = root.join(format!("{run}.source.json"));
    let mut wire = json!({"version":3,"kind":"native-graph-source","project":fixture.project,"branch":branch,"run":run,"profiles":[],"overlay":"inherit","env_metadata":{"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"web":{}},"inactive_scopes":[],"host":{"default":{},"workloads":{}}}});
    let request = json!({"request_version":1,"project":fs::read_to_string(fixture.marker()).unwrap(),"env_metadata":wire["env_metadata"]});
    let hack_config_compiler::environment::PlanResult::Success { semantic_hash, .. } =
        hack_config_compiler::environment::plan(&serde_json::to_vec(&request).unwrap(), &[])
    else {
        panic!("real host fixture must compile")
    };
    wire["hook_permit"] = private(
        &root.join(format!("{run}.hook-preflight-permit.json")),
        json!({"version":1,"kind":"native-authored-finite-hook-permit","role":"preflight","run":run,"project":fixture.project,"branch":branch,"semantic_hash":semantic_hash,"owner":owner,"pid":unsafe{libc::getppid()},"uid":unsafe{libc::getuid()}}),
    );
    fs::write(&path, wire.to_string()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    selection_refused(Source::read(&path));
    selection_refused(Source::read_frontend(&path, true));
    let selected = Source::read_frontend(&path, false)
        .unwrap()
        .select(&fixture.candidate, fixture.options().deadline)
        .unwrap();
    assert_eq!(
        serde_json::to_value(selected.review()).unwrap()["provenance"]["input"]["semantic_hash"],
        semantic_hash
    );
    let permit = root.join(format!("{run}.hook-preflight-permit.json"));
    let original = fs::read(&permit).unwrap();
    fs::remove_file(&permit).unwrap();
    fs::write(&permit, original).unwrap();
    fs::set_permissions(&permit, fs::Permissions::from_mode(0o600)).unwrap();
    selection_refused(selected.prepare(&fixture.candidate, &native::ManagedValues::new()));
    wire["hook_permit"] = private(
        &root.join(format!("{run}.hook-execution-permit.json")),
        json!({"version":1,"kind":"native-authored-finite-hook-permit","role":"execution","run":run,"project":fixture.project,"branch":branch,"semantic_hash":semantic_hash,"owner":owner,"pid":unsafe{libc::getppid()},"uid":unsafe{libc::getuid()}}),
    );
    fs::write(&path, wire.to_string()).unwrap();
    let execution = Source::read_frontend(&path, true)
        .unwrap()
        .select(&fixture.candidate, fixture.options().deadline)
        .unwrap();
    assert_eq!(
        serde_json::to_value(execution.review()).unwrap()["provenance"]["input"]["semantic_hash"],
        semantic_hash
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    selection_refused(Source::read_frontend(&path, true));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    wire["version"] = json!(2);
    wire["hook_permit"] = Value::Null;
    fs::write(&path, wire.to_string()).unwrap();
    selection_refused(Source::read(&path));
}

#[test]
fn frontend_process_source5_binds_owner_ready_and_rechecks_replacement_without_source3_bypass() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let mut project = basic();
    project["host"] = json!({"processes":{"tunnel":{"command":{"exec":["sleep","60"]}}}});
    fixture.write_project(project);
    let root = fixture.project.join(".hack/.internal/native-authored-runs");
    fs::create_dir_all(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let run = "b".repeat(32);
    let branch = Some("feature-one");
    let key = format!("{:x}", Sha256::digest(serde_json::to_vec(&branch).unwrap()));
    let private = |path: &Path, value: Value| {
        fs::write(path, value.to_string()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        let meta = fs::symlink_metadata(path).unwrap();
        json!({"path":path,"dev":meta.dev(),"ino":meta.ino(),"sha256":format!("{:x}",Sha256::digest(value.to_string().as_bytes()))})
    };
    // SAFETY: these pointer-free kernel identity queries do not mutate process state.
    let (pid, uid) = unsafe { (libc::getppid(), libc::getuid()) };
    let owner = private(
        &root.join(format!("{key}.hooks.json")),
        json!({"version":1,"kind":"native-authored-hook-owner","run":run,"project":fixture.project,"branch":branch,"selection":"a".repeat(64),"pid":pid,"uid":uid}),
    );
    let path = root.join(format!("{run}.source.json"));
    let mut wire = json!({"version":5,"kind":"native-graph-source","project":fixture.project,"branch":branch,"run":run,"profiles":[],"overlay":"inherit","env_metadata":{"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"web":{}},"inactive_scopes":[],"host":{"default":{},"workloads":{}}}});
    let request = json!({"request_version":1,"project":fs::read_to_string(fixture.marker()).unwrap(),"env_metadata":wire["env_metadata"]});
    let hack_config_compiler::environment::PlanResult::Success { semantic_hash, .. } =
        hack_config_compiler::environment::plan(&serde_json::to_vec(&request).unwrap(), &[])
    else {
        panic!("real process fixture must compile")
    };
    let process_owner = private(
        &root.join(format!("{run}.host-process-owner.json")),
        json!({"version":1,"kind":"native-authored-host-process-owner","run":run,"project":fixture.project,"branch":branch,"semantic_hash":semantic_hash,"pid":pid,"uid":uid,"names":["tunnel"],"compose_project":"native-authored-fixture","project_name":"fixture"}),
    );
    wire["hook_permit"] = private(
        &root.join(format!("{run}.hook-preflight-permit.json")),
        json!({"version":1,"kind":"native-authored-host-lifecycle-permit","role":"preflight","run":run,"project":fixture.project,"branch":branch,"semantic_hash":semantic_hash,"owner":owner,"pid":pid,"uid":uid,"processes":process_owner}),
    );
    fs::write(&path, wire.to_string()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    selection_refused(Source::read(&path));
    selection_refused(Source::read_frontend(&path, true));
    Source::read_frontend(&path, false)
        .unwrap()
        .select(&fixture.candidate, fixture.options().deadline)
        .unwrap();
    let mut wrong = wire.clone();
    wrong["version"] = json!(3);
    fs::write(&path, wrong.to_string()).unwrap();
    selection_refused(Source::read_frontend(&path, false));
    let ready_path = root.join(format!("{run}.host-process-ready.json"));
    let ready = private(
        &ready_path,
        json!({"version":1,"kind":"native-authored-host-process-ready","run":run,"project":fixture.project,"branch":branch,"semantic_hash":semantic_hash,"owner":process_owner,"pid":pid,"uid":uid}),
    );
    wire["hook_permit"] = private(
        &root.join(format!("{run}.hook-execution-permit.json")),
        json!({"version":1,"kind":"native-authored-host-lifecycle-permit","role":"execution","run":run,"project":fixture.project,"branch":branch,"semantic_hash":semantic_hash,"owner":owner,"pid":pid,"uid":uid,"processes":ready}),
    );
    fs::write(&path, wire.to_string()).unwrap();
    let selected = Source::read_frontend(&path, true)
        .unwrap()
        .select(&fixture.candidate, fixture.options().deadline)
        .unwrap();
    let original = fs::read(&ready_path).unwrap();
    fs::rename(&ready_path, root.join("preserved-ready")).unwrap();
    fs::write(&ready_path, original).unwrap();
    fs::set_permissions(&ready_path, fs::Permissions::from_mode(0o600)).unwrap();
    selection_refused(selected.prepare(&fixture.candidate, &native::ManagedValues::new()));
    assert!(!fixture.candidate.state_root.exists());
}
