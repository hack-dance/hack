use super::*;
use rusqlite::Connection;
use std::os::unix::fs::{DirBuilderExt, symlink};

static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct Fixture {
    directory: PathBuf,
    db: PathBuf,
    owner: Owner,
    record: Value,
    second: ProjectShareIntent,
    third: ProjectShareIntent,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}
fn project(directory: &Path, name: &str) -> ProjectShareIntent {
    let path = directory.join(name);
    fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
    fs::write(path.join("package.json"), "{}").unwrap();
    ProjectShareIntent::approve(&path, true).unwrap()
}
fn fixture() -> Fixture {
    let directory = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "share-update-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .unwrap();
    let primary = project(&directory, "first-app");
    let second = project(&directory, "second-app");
    let third = project(&directory, "third-app");
    let db = directory.join("provider.db");
    let record = json!({
        "name": "fixture",
        "mounts": [["/engine", "/opt/hack-engine", true], primary.database_mount()],
        "unrelated": {"preserved": true},
    });
    let connection = Connection::open(&db).unwrap();
    connection
        .execute(
            "CREATE TABLE vms(name TEXT PRIMARY KEY, data BLOB NOT NULL)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO vms VALUES('fixture', ?1)",
            [serde_json::to_vec(&record).unwrap()],
        )
        .unwrap();
    drop(connection);
    let owner: Owner = serde_json::from_value(json!({
        "version":1,"checkout":"/fixture","token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","machine":"fixture",
        "short_home":"/fixture","created":true,"phase":"stopped","process":null,
        "storage":null,"overlay":null,"guest_boot_id":null,"daemon_pid":null,"daemon_start":null,
        "rootfs_digest":null,"profile":"development","network":"internet",
        "project_share": primary,
    }))
    .unwrap();
    Fixture {
        directory,
        db,
        owner,
        record,
        second,
        third,
    }
}
fn identity(f: &Fixture) -> (u64, u64) {
    network_update::file_identity_with(&f.db, refused).unwrap()
}

#[test]
fn single_root_owner_receipts_keep_their_exact_bytes() {
    let f = fixture();
    let value = owner_value(&f.owner).unwrap();
    assert!(value.get("additional_project_shares").is_none());
    let reloaded: Owner = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(owner_value(&reloaded).unwrap(), value);
    assert_eq!(f.owner.project_shares().len(), 1);
}

#[test]
fn add_plans_only_the_share_set_and_record_mounts() {
    let f = fixture();
    let j = plan(
        &f.owner,
        f.record.clone(),
        Operation::Add,
        &f.second,
        identity(&f),
    )
    .unwrap();
    let (before, after) = validate(&j).unwrap();
    assert_eq!(before, f.owner);
    assert_eq!(
        after.project_shares(),
        vec![f.owner.project_share.as_ref().unwrap(), &f.second]
    );
    assert_eq!(after.project_share_for(&f.second.project), Some(&f.second));
    assert_eq!(j.record_after["unrelated"], f.record["unrelated"]);
    assert_eq!(j.record_after["mounts"][0], f.record["mounts"][0]);
    assert_eq!(j.record_after["mounts"][1], f.record["mounts"][1]);
    assert_eq!(j.record_after["mounts"][2], f.second.database_mount());
    // Any other owner or record change makes the journal invalid.
    let mut forged = plan(
        &f.owner,
        f.record.clone(),
        Operation::Add,
        &f.second,
        identity(&f),
    )
    .unwrap();
    forged.owner_after["machine"] = json!("foreign");
    assert!(validate(&forged).is_err());
    forged.owner_after["machine"] = json!("fixture");
    forged.record_after["unrelated"] = json!(false);
    assert!(validate(&forged).is_err());
    forged.record_after["unrelated"] = f.record["unrelated"].clone();
    forged.record_after["mounts"][2] = f.third.database_mount();
    assert!(validate(&forged).is_err());
}

#[test]
fn add_refuses_duplicates_unshared_pools_full_sets_and_drifted_records() {
    let f = fixture();
    let primary = f.owner.project_share.clone().unwrap();
    assert!(
        plan(
            &f.owner,
            f.record.clone(),
            Operation::Add,
            &primary,
            identity(&f)
        )
        .is_err()
    );
    let mut unshared = f.owner.clone();
    unshared.project_share = None;
    let mut bare = f.record.clone();
    bare["mounts"] = json!([["/engine", "/opt/hack-engine", true]]);
    assert!(plan(&unshared, bare, Operation::Add, &f.second, identity(&f)).is_err());
    let mut drifted = f.record.clone();
    drifted["mounts"] = json!([["/engine", "/opt/hack-engine", true]]);
    assert!(plan(&f.owner, drifted, Operation::Add, &f.second, identity(&f)).is_err());
    let mut full = f.owner.clone();
    let mut record = f.record.clone();
    for index in 1..MAX_PROJECT_SHARES {
        let share = project(&f.directory, &format!("filler-{index}"));
        record["mounts"]
            .as_array_mut()
            .unwrap()
            .push(share.database_mount());
        full.additional_project_shares.push(share);
    }
    assert!(plan(&full, record, Operation::Add, &f.second, identity(&f)).is_err());
}

#[test]
fn remove_never_takes_the_primary_and_keeps_other_shares_in_order() {
    let f = fixture();
    let primary = f.owner.project_share.clone().unwrap();
    let add = |owner: &Owner, record: &Value, share: &ProjectShareIntent| {
        let j = plan(owner, record.clone(), Operation::Add, share, identity(&f)).unwrap();
        (validate(&j).unwrap().1, j.record_after)
    };
    let (two, record) = add(&f.owner, &f.record, &f.second);
    let (three, record) = add(&two, &record, &f.third);
    assert!(
        plan(
            &three,
            record.clone(),
            Operation::Remove,
            &primary,
            identity(&f)
        )
        .is_err()
    );
    let j = plan(
        &three,
        record.clone(),
        Operation::Remove,
        &f.second,
        identity(&f),
    )
    .unwrap();
    let (_, after) = validate(&j).unwrap();
    assert_eq!(after.project_shares(), vec![&primary, &f.third]);
    assert_eq!(j.record_after["mounts"][2], f.third.database_mount());
    assert_eq!(j.record_after["mounts"].as_array().unwrap().len(), 3);
    // Removal matches the exact recorded receipt, never a look-alike.
    let mut forged = f.third.clone();
    forged.inode += 1;
    assert!(plan(&three, record, Operation::Remove, &forged, identity(&f)).is_err());
}

#[test]
fn interrupted_update_resumes_only_ordered_sides_without_repeating_effects() {
    let f = fixture();
    let j = plan(
        &f.owner,
        f.record.clone(),
        Operation::Add,
        &f.second,
        identity(&f),
    )
    .unwrap();
    let path = f.directory.join("journal.json");
    state::write(&path, &j).unwrap();
    let saved: Journal = state::read(&path).unwrap();
    validate_sides(&saved, &saved.owner_before, &saved.record_before).unwrap();
    network_update::apply_record(
        &f.db,
        "fixture",
        saved.database_identity,
        &saved.record_before,
        &saved.record_after,
        refused,
    )
    .unwrap();
    let current = config_audit::read_database(&f.db, "fixture").unwrap();
    assert_eq!(current, saved.record_after);
    // Crash after the record commit: the owner may still be `before`.
    validate_sides(&saved, &saved.owner_before, &current).unwrap();
    // Repeating the record commit is a no-op.
    network_update::apply_record(
        &f.db,
        "fixture",
        saved.database_identity,
        &saved.record_before,
        &saved.record_after,
        refused,
    )
    .unwrap();
    validate_sides(&saved, &saved.owner_after, &current).unwrap();
    // The owner never commits ahead of the record.
    assert!(validate_sides(&saved, &saved.owner_after, &saved.record_before).is_err());
    let mut running = saved.owner_before.clone();
    running["phase"] = json!("running");
    assert!(validate_sides(&saved, &running, &current).is_err());
}

#[test]
fn foreign_record_and_replaced_database_refuse_without_writes() {
    let f = fixture();
    let j = plan(
        &f.owner,
        f.record.clone(),
        Operation::Add,
        &f.second,
        identity(&f),
    )
    .unwrap();
    let connection = Connection::open(&f.db).unwrap();
    let mut changed = f.record.clone();
    changed["unrelated"] = json!(false);
    connection
        .execute(
            "UPDATE vms SET data=?1",
            [serde_json::to_vec(&changed).unwrap()],
        )
        .unwrap();
    drop(connection);
    let apply = || {
        network_update::apply_record(
            &f.db,
            "fixture",
            j.database_identity,
            &j.record_before,
            &j.record_after,
            refused,
        )
    };
    assert_eq!(apply().unwrap_err().code, "project_share_update");
    assert_eq!(
        config_audit::read_database(&f.db, "fixture").unwrap(),
        changed
    );
    let replacement = f.directory.join("replacement.db");
    fs::copy(&f.db, &replacement).unwrap();
    fs::rename(&replacement, &f.db).unwrap();
    assert!(apply().is_err());
}

#[test]
fn unfinished_or_aliased_share_journal_fences_startup_and_network_updates() {
    let f = fixture();
    let mut candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
    candidate.state_root = f.directory.clone();
    fs::create_dir_all(root(&candidate)).unwrap();
    require_complete(&candidate).unwrap();
    for name in [JOURNAL, "share-update.pending"] {
        let path = root(&candidate).join(name);
        fs::write(&path, b"incomplete").unwrap();
        assert!(require_complete(&candidate).is_err());
        fs::remove_file(&path).unwrap();
        symlink("missing", &path).unwrap();
        assert!(require_complete(&candidate).is_err());
        fs::remove_file(path).unwrap();
    }
}

#[test]
fn running_or_unproven_pool_refuses_before_any_effect() {
    let f = fixture();
    let candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
    let mut owner = f.owner.clone();
    assert_eq!(
        network_update::stopped_with(&candidate, &owner, refused)
            .unwrap_err()
            .code,
        "project_share_update"
    );
    owner.phase = "running".into();
    assert!(network_update::stopped_with(&candidate, &owner, refused).is_err());
    assert_eq!(
        config_audit::read_database(&f.db, "fixture").unwrap(),
        f.record
    );
}

#[test]
fn removal_refuses_while_any_retained_graph_names_the_share() {
    let f = fixture();
    let mut candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
    candidate.state_root = f.directory.join("state");
    fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(candidate.state_root.join("run"))
        .unwrap();
    assert!(require_unreferenced(&candidate, &f.owner.token, &f.second).is_ok());
    for parent in ["run/graphs", "run/native-graphs"] {
        let run = candidate.state_root.join(parent).join("a".repeat(32));
        fs::DirBuilder::new()
            .mode(0o700)
            .recursive(true)
            .create(&run)
            .unwrap();
        // Another project's retained graph never blocks this share.
        fs::write(
            run.join("state.json"),
            serde_json::to_vec(&json!({"source":{"shared": f.third}})).unwrap(),
        )
        .unwrap();
        assert!(require_unreferenced(&candidate, &f.owner.token, &f.second).is_ok());
        fs::write(
            run.join("state.pending"),
            serde_json::to_vec(&json!({"source":{"shared": f.second}})).unwrap(),
        )
        .unwrap();
        assert_eq!(
            require_unreferenced(&candidate, &f.owner.token, &f.second)
                .unwrap_err()
                .code,
            "project_share_in_use"
        );
        fs::remove_file(run.join("state.pending")).unwrap();
        let nested = run.join("transport");
        fs::DirBuilder::new().mode(0o700).create(&nested).unwrap();
        fs::write(nested.join("binding.json"), f.second.guest_path.as_bytes()).unwrap();
        assert_eq!(
            require_unreferenced(&candidate, &f.owner.token, &f.second)
                .unwrap_err()
                .code,
            "project_share_in_use"
        );
        fs::remove_dir_all(&nested).unwrap();
        // An aliased record is never followed.
        symlink(run.join("state.json"), run.join("alias.json")).unwrap();
        assert_eq!(
            require_unreferenced(&candidate, &f.owner.token, &f.second)
                .unwrap_err()
                .code,
            "project_share_update"
        );
        fs::remove_file(run.join("alias.json")).unwrap();
    }
}

#[test]
fn interrupted_addition_resumes_its_recorded_share_after_the_root_is_removed() {
    let f = fixture();
    let mut candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
    candidate.state_root = f.directory.join("state");
    fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(root(&candidate))
        .unwrap();
    // A new addition checks its root live.
    assert_eq!(
        addition(&candidate, &f.third.project, true).unwrap(),
        f.third
    );
    assert!(addition(&candidate, &f.third.project, false).is_err());
    let j = plan(
        &f.owner,
        f.record.clone(),
        Operation::Add,
        &f.second,
        identity(&f),
    )
    .unwrap();
    state::write(&root(&candidate).join(JOURNAL), &j).unwrap();
    // The added root disappears before the interrupted update is repeated.
    fs::remove_dir_all(&f.second.project).unwrap();
    assert!(f.second.validate().is_err());
    assert_eq!(
        addition(&candidate, &f.second.project, true).unwrap(),
        f.second
    );
    // A recreated directory has another identity; the recorded receipt still wins.
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&f.second.project)
        .unwrap();
    fs::write(f.second.project.join("package.json"), "{}").unwrap();
    assert_ne!(
        ProjectShareIntent::approve(&f.second.project, true).unwrap(),
        f.second
    );
    assert_eq!(
        addition(&candidate, &f.second.project, true).unwrap(),
        f.second
    );
    // Only the journal's own root and consent resume it.
    assert!(addition(&candidate, &f.third.project, true).is_err());
    assert!(addition(&candidate, &f.second.project, false).is_err());
    // The completed addition boots only after the stale share is removed, and that
    // removal plans offline from the recorded receipt.
    let (_, after) = validate(&j).unwrap();
    assert_eq!(
        project_share::check_boot(&after.project_shares())
            .unwrap_err()
            .code,
        "project_share_stale"
    );
    let removal = plan(
        &after,
        j.record_after.clone(),
        Operation::Remove,
        &f.second,
        identity(&f),
    )
    .unwrap();
    let (_, removed) = validate(&removal).unwrap();
    assert_eq!(removed, f.owner);
    assert_eq!(removal.record_after, f.record);
    // Without a journal, a missing root is never added.
    fs::remove_file(root(&candidate).join(JOURNAL)).unwrap();
    fs::remove_dir_all(&f.third.project).unwrap();
    assert!(addition(&candidate, &f.third.project, true).is_err());
}
