use super::*;
#[cfg(target_os = "macos")]
use std::os::unix::fs::{FileExt, FileTypeExt};

const ROOTFS: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn pins() -> Pins {
    Pins::current(Profile::Research, ROOTFS)
}

struct Fixture {
    root: PathBuf,
}

/// Paths of the fixture pool, laid out as under the lifecycle's `run/smolvm`.
struct PoolPaths {
    root: PathBuf,
    #[cfg(target_os = "macos")]
    templates: PathBuf,
    #[cfg(target_os = "macos")]
    record: PathBuf,
    #[cfg(target_os = "macos")]
    pending: PathBuf,
    disks: [PathBuf; 2],
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-prepared-base-{label}-{}",
            random_hex().unwrap()
        ));
        state::private_directory(&root).unwrap();
        for dir in ["store", "seed", "pool/vm"] {
            state::private_directory(&root.join(dir)).unwrap();
        }
        state::private_directory(&root.join("pool").join(TEMPLATE_DIR)).unwrap();
        Self { root }
    }

    #[cfg(target_os = "macos")]
    fn store(&self) -> PathBuf {
        self.root.join("store")
    }

    fn pool(&self) -> PoolPaths {
        let root = self.root.join("pool");
        PoolPaths {
            #[cfg(target_os = "macos")]
            templates: root.join(TEMPLATE_DIR),
            #[cfg(target_os = "macos")]
            record: root.join(RECORD),
            #[cfg(target_os = "macos")]
            pending: root.join(PENDING),
            disks: [root.join("vm/storage.raw"), root.join("vm/overlay.raw")],
            root,
        }
    }

    /// A sparse seed disk with a little data.
    #[cfg(target_os = "macos")]
    fn seed(&self, name: &str, len: u64, marker: &[u8]) -> PathBuf {
        let path = self.root.join("seed").join(name);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        file.write_all_at(marker, 0).unwrap();
        file.write_all_at(marker, 3 * 1024 * 1024 + 17).unwrap();
        file.set_len(len).unwrap();
        path
    }

    /// Publish `base_id` from its seed disks, creating them on first use.
    #[cfg(target_os = "macos")]
    fn publish(&self, base_id: &str) -> Result<Receipt, CandidateError> {
        let capacity = pins().capacity_bytes();
        let seed = |kind: &str, len: u64| {
            let name = format!("{base_id}-{kind}.raw");
            let path = self.root.join("seed").join(&name);
            if path.exists() {
                path
            } else {
                self.seed(&name, len, kind.as_bytes())
            }
        };
        let storage = seed("storage", capacity[0]);
        let overlay = seed("overlay", capacity[1]);
        publish(
            &self.store(),
            &PublishRequest {
                base_id,
                pins: pins(),
                sources: [&storage, &overlay],
                sanitization: Sanitization::sanitized(),
            },
        )
    }

    #[cfg(target_os = "macos")]
    fn base(&self) -> PublishedBase {
        self.publish("base-1").unwrap();
        open_published(&self.store(), "base-1").unwrap()
    }

    #[cfg(target_os = "macos")]
    fn entries(&self, dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Run `check` against the fixture pool while holding its provider operation lock.
#[cfg(target_os = "macos")]
fn with_pool<T>(fixture: &Fixture, check: impl FnOnce(&PoolTarget<'_>) -> T) -> T {
    let pool = fixture.pool();
    let lock = state::Lock::acquire(&pool.root).unwrap();
    let target = PoolTarget::new(&pool.root, &lock, [&pool.disks[0], &pool.disks[1]]).unwrap();
    check(&target)
}

#[cfg(target_os = "macos")]
fn overwrite(path: &Path, at: u64, bytes: &[u8]) {
    let mode = fs::metadata(path).unwrap().mode() & 0o777;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .write_all_at(bytes, at)
        .unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

type Mutation = fn(&mut Receipt);

fn receipt() -> Receipt {
    let capacity = pins().capacity_bytes();
    Receipt {
        schema: RECEIPT_SCHEMA.into(),
        base_id: "base-1".into(),
        state: PUBLISHED.into(),
        pins: pins(),
        network_tools_owner: "prepared-base:base-1".into(),
        templates: TEMPLATES
            .iter()
            .zip(capacity)
            .map(|(name, len)| TemplateRecord {
                name: (*name).into(),
                logical_len: len,
                content_sha256: "b".repeat(64),
                data_bytes: 8192,
            })
            .collect(),
        sanitization: Sanitization::sanitized(),
    }
}

fn intent(base: &PublishedBase, pool: (u64, u64), nonce: &str) -> ActivationRecord {
    ActivationRecord {
        schema: ACTIVATION_SCHEMA.into(),
        base_id: base.receipt.base_id.clone(),
        receipt_sha256: base.receipt_sha256.clone(),
        nonce: nonce.into(),
        state: ActivationState::Activating,
        templates: base.receipt.templates.clone(),
        clones: vec![None, None],
        pool,
    }
}

/// Clone template `index` of `base` to `nonce`'s temporary path, as `place` does.
#[cfg(target_os = "macos")]
fn clone_temporary(
    base: &PublishedBase,
    pool: &PoolPaths,
    nonce: &str,
    index: usize,
) -> (PathBuf, (u64, u64)) {
    let path = pool
        .templates
        .join(format!(".prepared-{nonce}-{}", TEMPLATES[index]));
    clone_file(&base.dir.join(TEMPLATES[index]), &path).unwrap();
    let metadata = fs::metadata(&path).unwrap();
    (path, (metadata.dev(), metadata.ino()))
}

#[cfg(target_os = "macos")]
fn fifo(path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: a valid NUL-terminated path for the duration of the call; mkfifo retains nothing.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
}

/// Run `operation` on another thread and fail if it does not return promptly.
#[cfg(target_os = "macos")]
fn without_blocking<T: Send + 'static>(operation: impl FnOnce() -> T + Send + 'static) -> T {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(operation());
    });
    receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("operation blocked")
}

#[test]
fn receipt_schema_ownership_and_sanitization_are_strict() {
    receipt().validate("base-1").unwrap();
    let mut value = serde_json::to_value(receipt()).unwrap();
    value["unexpected"] = serde_json::json!(true);
    assert!(serde_json::from_value::<Receipt>(value).is_err());
    let cases: [(&str, Mutation); 7] = [
        ("schema", |r| r.schema = "hack.prepared-base/v2".into()),
        ("unpublished", |r| r.state = "staging".into()),
        ("other base", |r| r.base_id = "base-2".into()),
        ("network owner", |r| {
            r.network_tools_owner = "prepared-base:other".into()
        }),
        ("capacity", |r| r.templates[1].logical_len += 4096),
        ("data budget", |r| {
            r.templates[0].data_bytes = r.templates[0].logical_len + 1
        }),
        ("sanitization", |r| r.sanitization.volumes = 1),
    ];
    for (label, mutate) in cases {
        let mut candidate = receipt();
        mutate(&mut candidate);
        let refused = candidate.validate("base-1").unwrap_err();
        assert_eq!(refused.code, "prepared_base_invalid", "{label}");
    }
    for id in ["", "-leading", "Upper", "dot.dot", &"a".repeat(65)] {
        assert!(!valid_base_id(id), "{id}");
    }
    // The clone read budget covers page-granular extent reporting but never exceeds the file.
    let mut template = receipt().templates.remove(0);
    assert_eq!(template.read_budget(), 4 * 8192 + 16 * 1024 * 1024);
    template.data_bytes = template.logical_len;
    assert_eq!(template.read_budget(), template.logical_len);
}

#[test]
fn binding_requires_the_pool_capacity_and_every_pin() {
    let base = PublishedBase {
        dir: PathBuf::from("/unused"),
        receipt: receipt(),
        receipt_sha256: "c".repeat(64),
    };
    base.bind(&pins()).unwrap();
    let development = Pins::current(Profile::Development, ROOTFS);
    assert_eq!(
        base.bind(&development).unwrap_err().code,
        "prepared_base_capacity"
    );
    let cases: [fn(&mut Pins); 6] = [
        |p| p.smolvm_version = "1.14.4".into(),
        |p| p.smolvm_archive_sha256 = "d".repeat(64),
        |p| p.agent_rootfs_sha256 = "d".repeat(64),
        |p| p.engine_version = "0".into(),
        |p| p.engine_sha256 = "d".repeat(64),
        |p| p.network_tools_identity = "d".repeat(64),
    ];
    for mutate in cases {
        let mut pool = pins();
        mutate(&mut pool);
        assert_eq!(
            base.bind(&pool).unwrap_err().code,
            "prepared_base_pin_mismatch"
        );
    }
}

#[test]
fn network_tools_owner_is_base_scoped_once_a_base_is_activated() {
    let base = PublishedBase {
        dir: PathBuf::from("/unused"),
        receipt: receipt(),
        receipt_sha256: "c".repeat(64),
    };
    let bound = (0, 0);
    let mut record = intent(&base, bound, &"0".repeat(32));
    assert_eq!(network_tools_owner(None, "token"), "token");
    assert_eq!(network_tools_owner(Some(&record), "token"), "token");
    for state in [ActivationState::Activated, ActivationState::Consumed] {
        record.state = state;
        assert_eq!(
            network_tools_owner(Some(&record), "token"),
            "prepared-base:base-1"
        );
    }
}

#[test]
fn pool_operations_require_this_pool_operation_lock() {
    let fixture = Fixture::new("lock");
    let pool = fixture.pool();
    let disks = [pool.disks[0].as_path(), pool.disks[1].as_path()];
    // Another pool's lock is no proof.
    let other = fixture.root.join("other");
    let foreign = state::Lock::acquire(&other).unwrap();
    assert_eq!(
        PoolTarget::new(&pool.root, &foreign, disks)
            .err()
            .unwrap()
            .code,
        "prepared_base_lock_required"
    );
    // Each operation rechecks: a replaced lock file no longer proves the held lock.
    let lock = state::Lock::acquire(&pool.root).unwrap();
    let target = PoolTarget::new(&pool.root, &lock, disks).unwrap();
    assert_eq!(recover(&target).unwrap(), Recovery::Nothing);
    fs::rename(pool.root.join(LOCK), pool.root.join("replaced.lock")).unwrap();
    fs::write(pool.root.join(LOCK), b"").unwrap();
    assert_eq!(
        recover(&target).unwrap_err().code,
        "prepared_base_lock_required"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn publication_is_atomic_private_and_never_replaces() {
    let fixture = Fixture::new("publish");
    let receipt = fixture.publish("base-1").unwrap();
    let base = open_published(&fixture.store(), "base-1").unwrap();
    assert_eq!(base.receipt, receipt);
    // The receipt records the seed's actual content, not its metadata.
    for (record, name) in receipt.templates.iter().zip(["storage", "overlay"]) {
        let seed = File::open(fixture.root.join(format!("seed/base-1-{name}.raw"))).unwrap();
        let digest = disk_template::content_digest(&seed, record.logical_len, u64::MAX)
            .unwrap()
            .unwrap();
        assert_eq!(record.content_sha256, digest.sha256);
        assert_eq!(record.data_bytes, digest.read);
        let published = fs::metadata(fixture.store().join("base-1").join(&record.name)).unwrap();
        assert_eq!(published.mode() & 0o777, 0o400);
    }
    assert_eq!(fixture.entries(&fixture.store()), ["base-1"]);

    // Publishing the same id again changes nothing.
    let receipt_path = fixture.store().join("base-1").join(RECEIPT);
    let before = fs::read(&receipt_path).unwrap();
    assert_eq!(
        fixture.publish("base-1").unwrap_err().code,
        "prepared_base_exists"
    );
    assert_eq!(fs::read(&receipt_path).unwrap(), before);

    // A failed publication leaves neither its staging directory nor a base.
    let capacity = pins().capacity_bytes();
    let short = fixture.seed("short.raw", capacity[0] - 4096, b"short");
    let overlay = fixture.seed("overlay.raw", capacity[1], b"overlay");
    let refused = publish(
        &fixture.store(),
        &PublishRequest {
            base_id: "base-2",
            pins: pins(),
            sources: [&short, &overlay],
            sanitization: Sanitization::sanitized(),
        },
    )
    .unwrap_err();
    assert_eq!(refused.code, "prepared_base_invalid");
    assert_eq!(fixture.entries(&fixture.store()), ["base-1"]);

    // An interrupted publication is a staging directory readers never consult, even when it
    // holds a complete receipt; a base directory without a receipt is incomplete.
    let staging = fixture.store().join(".staging-interrupted");
    state::private_directory(&staging).unwrap();
    fs::copy(&receipt_path, staging.join(RECEIPT)).unwrap();
    assert_eq!(
        open_published(&fixture.store(), "interrupted")
            .unwrap_err()
            .code,
        "prepared_base_missing"
    );
    let partial = fixture.store().join("base-3");
    state::private_directory(&partial).unwrap();
    for name in TEMPLATES {
        fixture.seed(name, 4096, b"x");
        fs::rename(fixture.root.join("seed").join(name), partial.join(name)).unwrap();
    }
    assert_eq!(
        open_published(&fixture.store(), "base-3").unwrap_err().code,
        "prepared_base_incomplete"
    );
    // A receipt that is not in the published state is refused.
    let mut edited: serde_json::Value = serde_json::from_slice(&before).unwrap();
    edited["state"] = serde_json::json!("staging");
    fs::set_permissions(&receipt_path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&receipt_path, serde_json::to_vec(&edited).unwrap()).unwrap();
    assert_eq!(
        open_published(&fixture.store(), "base-1").unwrap_err().code,
        "prepared_base_invalid"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn placement_renames_never_replace_an_existing_file_or_directory() {
    let fixture = Fixture::new("rename");
    let source = fixture.root.join("seed/source");
    fs::write(&source, b"new").unwrap();
    let file = fixture.root.join("seed/existing");
    fs::write(&file, b"old").unwrap();
    // A plain rename(2) would replace both of these destinations.
    let empty = fixture.root.join("seed/empty");
    fs::create_dir(&empty).unwrap();
    let staged = fixture.root.join("seed/staged");
    fs::create_dir(&staged).unwrap();
    for (from, to) in [(&source, &file), (&staged, &empty)] {
        let refused = rename_new(from, to).unwrap_err();
        assert_eq!(refused.raw_os_error(), Some(libc::EEXIST));
        assert!(from.exists());
    }
    assert_eq!(fs::read(&file).unwrap(), b"old");
    rename_new(&source, &fixture.root.join("seed/fresh")).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn store_and_base_ownership_are_checked_before_use() {
    let fixture = Fixture::new("ownership");
    fixture.publish("base-1").unwrap();
    let store = fixture.store();
    assert_eq!(
        open_published(Path::new("relative"), "base-1")
            .unwrap_err()
            .code,
        "prepared_base_invalid"
    );
    let alias = fixture.root.join("alias");
    std::os::unix::fs::symlink(&store, &alias).unwrap();
    assert_eq!(
        open_published(&alias, "base-1").unwrap_err().code,
        "aliased_state"
    );
    fs::set_permissions(&store, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        open_published(&store, "base-1").unwrap_err().code,
        "foreign_state"
    );
    fs::set_permissions(&store, fs::Permissions::from_mode(0o700)).unwrap();
    let base = store.join("base-1");
    fs::hard_link(base.join(TEMPLATES[0]), fixture.root.join("second-link")).unwrap();
    assert_eq!(
        open_published(&store, "base-1").unwrap_err().code,
        "prepared_base_ownership"
    );
    fs::remove_file(fixture.root.join("second-link")).unwrap();
    fs::write(base.join("extra"), b"").unwrap();
    assert_eq!(
        open_published(&store, "base-1").unwrap_err().code,
        "prepared_base_incomplete"
    );
    fs::remove_file(base.join("extra")).unwrap();
    open_published(&store, "base-1").unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn fifos_are_refused_without_blocking() {
    let fixture = Fixture::new("fifo");
    fixture.publish("base-1").unwrap();
    // A receipt replaced by a FIFO with no writer.
    let store = fixture.store();
    let receipt = store.join("base-1").join(RECEIPT);
    fs::remove_file(&receipt).unwrap();
    fifo(&receipt);
    let code = without_blocking(move || open_published(&store, "base-1").unwrap_err().code);
    assert_eq!(code, "prepared_base_ownership");

    // An activation record, then a pending record write, replaced by a FIFO with no writer.
    let pool = fixture.pool();
    for path in [&pool.record, &pool.pending] {
        fifo(path);
        let (root, disks) = (pool.root.clone(), pool.disks.clone());
        let code = without_blocking(move || {
            let lock = state::Lock::acquire(&root).unwrap();
            let target = PoolTarget::new(&root, &lock, [&disks[0], &disks[1]]).unwrap();
            recover(&target).unwrap_err().code
        });
        assert_eq!(code, "foreign_state");
        // Refused, not removed.
        assert!(fs::symlink_metadata(path).unwrap().file_type().is_fifo());
        fs::remove_file(path).unwrap();
    }
}

#[cfg(target_os = "macos")]
#[test]
fn activation_verifies_a_private_clone_before_placing_it() {
    let fixture = Fixture::new("activate");
    let base = fixture.base();
    let record = with_pool(&fixture, |pool| activate(&base, &pins(), pool)).unwrap();
    assert_eq!(record.state, ActivationState::Activated);
    assert_eq!(record.receipt_sha256, base.receipt_sha256);
    let pool = fixture.pool();
    assert_eq!(
        fixture.entries(&pool.templates),
        ["overlay-template.ext4", "storage-template.ext4"]
    );
    for (name, identity) in TEMPLATES.iter().zip(&record.clones) {
        let placed = fs::metadata(pool.templates.join(name)).unwrap();
        assert_eq!(Some((placed.dev(), placed.ino())), *identity);
        // SmolVM copies this mode into the machine disk, which must be writable.
        assert_eq!(placed.mode() & 0o777, 0o600);
    }
    with_pool(&fixture, verify_activated).unwrap();

    // The clone is independent of the store: a later store change does not reach it...
    overwrite(&fixture.store().join("base-1").join(TEMPLATES[0]), 0, b"S");
    with_pool(&fixture, verify_activated).unwrap();
    // ...and a change to the activated clone itself is refused by content, not metadata.
    overwrite(
        &pool.templates.join(TEMPLATES[1]),
        3 * 1024 * 1024 + 17,
        b"O",
    );
    let refused = with_pool(&fixture, verify_activated).unwrap_err();
    assert_eq!(refused.code, "prepared_base_digest");
    assert!(
        refused.message.contains("content differs"),
        "{}",
        refused.message
    );
}

#[cfg(target_os = "macos")]
#[test]
fn a_corrupt_store_template_is_refused_and_the_activation_rolled_back() {
    let fixture = Fixture::new("corrupt");
    fixture.publish("base-1").unwrap();
    // Same size, same owner and mode: only the content digest can notice.
    overwrite(&fixture.store().join("base-1").join(TEMPLATES[1]), 0, b"x");
    let base = open_published(&fixture.store(), "base-1").unwrap();
    let refused = with_pool(&fixture, |pool| activate(&base, &pins(), pool)).unwrap_err();
    assert_eq!(refused.code, "prepared_base_digest");
    let pool = fixture.pool();
    assert!(fixture.entries(&pool.templates).is_empty());
    assert!(!pool.record.exists() && !pool.pending.exists());
}

#[cfg(target_os = "macos")]
#[test]
fn activation_is_fresh_pool_only_and_adopts_nothing() {
    let fixture = Fixture::new("fresh");
    let base = fixture.base();
    let pool = fixture.pool();

    // The first start has formatted the disks: too late to seed them.
    fs::write(&pool.disks[0], b"").unwrap();
    let refused = with_pool(&fixture, |target| activate(&base, &pins(), target)).unwrap_err();
    assert_eq!(refused.code, "prepared_base_not_fresh");
    fs::remove_file(&pool.disks[0]).unwrap();

    // A plain template of any origin is never adopted or replaced.
    fs::write(pool.templates.join(TEMPLATES[0]), b"stock").unwrap();
    let refused = with_pool(&fixture, |target| activate(&base, &pins(), target)).unwrap_err();
    assert_eq!(refused.code, "foreign_state");
    assert_eq!(
        fs::read(pool.templates.join(TEMPLATES[0])).unwrap(),
        b"stock"
    );
    fs::remove_file(pool.templates.join(TEMPLATES[0])).unwrap();

    // A capacity or pin mismatch creates nothing.
    let development = Pins::current(Profile::Development, ROOTFS);
    let refused = with_pool(&fixture, |target| activate(&base, &development, target)).unwrap_err();
    assert_eq!(refused.code, "prepared_base_capacity");
    assert!(fixture.entries(&pool.templates).is_empty());
    assert!(!pool.record.exists());

    with_pool(&fixture, |target| activate(&base, &pins(), target)).unwrap();
    let refused = with_pool(&fixture, |target| activate(&base, &pins(), target)).unwrap_err();
    assert_eq!(refused.code, "prepared_base_recovery_required");
}

#[cfg(target_os = "macos")]
#[test]
fn stock_pins_refuse_a_base_so_a_bound_pool_verifies_against_its_receipt() {
    let fixture = Fixture::new("coordinate");
    let base = fixture.base();
    with_pool(&fixture, |pool| activate(&base, &pins(), pool)).unwrap();
    // The unbound pool check still refuses the activated base; it is replaced by
    // `verify_activated` for a bound pool, never skipped.
    for stage in [
        disk_template::Stage::BeforeUse,
        disk_template::Stage::AfterFirstStart,
    ] {
        let refused = disk_template::verify_expanded(&fixture.pool().templates, stage).unwrap_err();
        assert_eq!(refused.code, "disk_template_untrusted");
    }
    with_pool(&fixture, verify_activated).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn recovery_before_the_first_start_removes_only_this_activation_files() {
    let fixture = Fixture::new("recover");
    let base = fixture.base();
    let pool = fixture.pool();
    let bound = identity_of(&pool.root).unwrap().unwrap();

    // Interrupted after the intent record, before any clone.
    with_pool(&fixture, |target| {
        write_record(target, &intent(&base, bound, &"1".repeat(32)))
    })
    .unwrap();
    assert_eq!(with_pool(&fixture, recover).unwrap(), Recovery::RolledBack);
    assert!(!pool.record.exists());

    // Interrupted after a clone, before its identity was recorded: the nonce proves it.
    let nonce = "2".repeat(32);
    with_pool(&fixture, |target| {
        write_record(target, &intent(&base, bound, &nonce))
    })
    .unwrap();
    let (orphan, _) = clone_temporary(&base, &pool, &nonce, 0);
    assert_eq!(with_pool(&fixture, recover).unwrap(), Recovery::RolledBack);
    assert!(!orphan.exists());

    // Interrupted between the two renames.
    let nonce = "3".repeat(32);
    let mut record = intent(&base, bound, &nonce);
    let (storage, storage_id) = clone_temporary(&base, &pool, &nonce, 0);
    let (overlay, overlay_id) = clone_temporary(&base, &pool, &nonce, 1);
    record.clones = vec![Some(storage_id), Some(overlay_id)];
    with_pool(&fixture, |target| write_record(target, &record)).unwrap();
    fs::rename(&storage, pool.templates.join(TEMPLATES[0])).unwrap();
    assert_eq!(with_pool(&fixture, recover).unwrap(), Recovery::RolledBack);
    assert!(fixture.entries(&pool.templates).is_empty() && !overlay.exists());

    // A plain template this record cannot prove it created stops recovery before anything
    // is removed, including files it does own.
    let nonce = "4".repeat(32);
    with_pool(&fixture, |target| {
        write_record(target, &intent(&base, bound, &nonce))
    })
    .unwrap();
    let (owned, _) = clone_temporary(&base, &pool, &nonce, 0);
    fs::write(pool.templates.join(TEMPLATES[1]), b"foreign").unwrap();
    assert_eq!(
        with_pool(&fixture, recover).unwrap_err().code,
        "foreign_state"
    );
    assert!(owned.exists() && pool.record.exists());
    assert_eq!(
        fs::read(pool.templates.join(TEMPLATES[1])).unwrap(),
        b"foreign"
    );
    fs::remove_file(pool.templates.join(TEMPLATES[1])).unwrap();
    assert_eq!(with_pool(&fixture, recover).unwrap(), Recovery::RolledBack);

    // After the first start the activated templates are the disks' provenance: kept.
    with_pool(&fixture, |target| activate(&base, &pins(), target)).unwrap();
    fs::write(&pool.disks[0], b"").unwrap();
    assert_eq!(
        with_pool(&fixture, recover).unwrap_err().code,
        "prepared_base_recovery_required"
    );
    with_pool(&fixture, verify_activated).unwrap();
    fs::remove_file(&pool.disks[0]).unwrap();

    // Rolled back before the first start, the pool is fresh again.
    assert_eq!(with_pool(&fixture, recover).unwrap(), Recovery::RolledBack);
    assert!(fixture.entries(&pool.templates).is_empty());
    with_pool(&fixture, |target| activate(&base, &pins(), target)).unwrap();
}

/// Each case stops a writer between staging its pending record and committing it (or tears the
/// staged bytes), exactly where a crash can, then resumes with the public operations.
#[cfg(target_os = "macos")]
#[test]
fn interrupted_record_writes_are_reconciled_at_each_writer_window() {
    let fixture = Fixture::new("pending");
    let base = fixture.base();
    let pool = fixture.pool();
    let bound = identity_of(&pool.root).unwrap().unwrap();
    let committed = || ActivationRecord::load_path(&pool.record);

    // First intent staged, never committed: nothing happened, so activation proceeds.
    with_pool(&fixture, |target| {
        stage_record(target, &intent(&base, bound, &"1".repeat(32)))
    })
    .unwrap();
    assert!(pool.pending.exists() && !pool.record.exists());
    with_pool(&fixture, |target| activate(&base, &pins(), target)).unwrap();
    assert!(!pool.pending.exists());
    assert_eq!(with_pool(&fixture, recover).unwrap(), Recovery::RolledBack);

    // A torn first intent cannot be validated: it is kept, and the pool's prepared-base
    // operations refuse until someone inspects and removes it.
    let bytes = serde_json::to_vec_pretty(&intent(&base, bound, &"2".repeat(32))).unwrap();
    with_pool(&fixture, |target| {
        stage_record(target, &intent(&base, bound, &"2".repeat(32)))
    })
    .unwrap();
    fs::write(&pool.pending, &bytes[..bytes.len() / 2]).unwrap();
    for refused in [
        with_pool(&fixture, recover).map(|_| ()),
        with_pool(&fixture, |target| activate(&base, &pins(), target)).map(|_| ()),
    ] {
        assert_eq!(refused.unwrap_err().code, "prepared_base_recovery_required");
    }
    assert_eq!(fs::read(&pool.pending).unwrap(), &bytes[..bytes.len() / 2]);
    fs::remove_file(&pool.pending).unwrap();
    assert_eq!(with_pool(&fixture, recover).unwrap(), Recovery::Nothing);

    // Identity write staged after a clone: the committed intent's nonce proves the clone.
    let nonce = "3".repeat(32);
    let mut record = intent(&base, bound, &nonce);
    with_pool(&fixture, |target| write_record(target, &record)).unwrap();
    let (storage, storage_id) = clone_temporary(&base, &pool, &nonce, 0);
    record.clones[0] = Some(storage_id);
    with_pool(&fixture, |target| stage_record(target, &record)).unwrap();
    assert_eq!(with_pool(&fixture, recover).unwrap(), Recovery::RolledBack);
    assert!(!storage.exists() && !pool.pending.exists() && !pool.record.exists());

    // `activated` staged after both renames: the committed record still says `activating`, so
    // the placed templates are rolled back by their recorded identities.
    let nonce = "4".repeat(32);
    let mut record = intent(&base, bound, &nonce);
    let (storage, storage_id) = clone_temporary(&base, &pool, &nonce, 0);
    let (overlay, overlay_id) = clone_temporary(&base, &pool, &nonce, 1);
    record.clones = vec![Some(storage_id), Some(overlay_id)];
    with_pool(&fixture, |target| write_record(target, &record)).unwrap();
    fs::rename(&storage, pool.templates.join(TEMPLATES[0])).unwrap();
    fs::rename(&overlay, pool.templates.join(TEMPLATES[1])).unwrap();
    record.state = ActivationState::Activated;
    with_pool(&fixture, |target| stage_record(target, &record)).unwrap();
    assert_eq!(
        with_pool(&fixture, verify_activated).unwrap_err().code,
        "prepared_base_recovery_required"
    );
    assert_eq!(with_pool(&fixture, recover).unwrap(), Recovery::RolledBack);
    assert!(fixture.entries(&pool.templates).is_empty() && !pool.pending.exists());

    // `consumed` staged after both templates were removed: consumption completes.
    let record = with_pool(&fixture, |target| activate(&base, &pins(), target)).unwrap();
    for disk in &pool.disks {
        fs::write(disk, b"").unwrap();
    }
    for name in TEMPLATES {
        fs::remove_file(pool.templates.join(name)).unwrap();
    }
    let mut consumed = record.clone();
    consumed.state = ActivationState::Consumed;
    with_pool(&fixture, |target| stage_record(target, &consumed)).unwrap();
    with_pool(&fixture, consume).unwrap();
    assert_eq!(committed().state, ActivationState::Consumed);
    assert!(!pool.pending.exists());

    // Interrupted between the two removals, before staging: consumption also completes.
    fs::remove_file(&pool.record).unwrap();
    for disk in &pool.disks {
        fs::remove_file(disk).unwrap();
    }
    with_pool(&fixture, |target| activate(&base, &pins(), target)).unwrap();
    for disk in &pool.disks {
        fs::write(disk, b"").unwrap();
    }
    fs::remove_file(pool.templates.join(TEMPLATES[0])).unwrap();
    with_pool(&fixture, consume).unwrap();
    assert!(fixture.entries(&pool.templates).is_empty());
    assert_eq!(committed().state, ActivationState::Consumed);

    // Private pending files that are not a validated write associated with the committed
    // activation are kept for inspection: another schema, garbage, another activation of this
    // pool, and this activation's record copied from another pool.
    let committed_record = committed();
    let mut other_pool = committed_record.clone();
    other_pool.pool.1 += 1;
    let cases: [(&str, Vec<u8>); 4] = [
        ("other schema", br#"{"schema":"other"}"#.to_vec()),
        ("garbage", b"\x00not a record".to_vec()),
        (
            "other activation",
            serde_json::to_vec(&intent(&base, bound, &"5".repeat(32))).unwrap(),
        ),
        ("other pool", serde_json::to_vec(&other_pool).unwrap()),
    ];
    for (label, bytes) in cases {
        fs::write(&pool.pending, &bytes).unwrap();
        fs::set_permissions(&pool.pending, fs::Permissions::from_mode(0o600)).unwrap();
        let refused = with_pool(&fixture, recover).unwrap_err();
        assert_eq!(refused.code, "prepared_base_recovery_required", "{label}");
        assert_eq!(fs::read(&pool.pending).unwrap(), bytes, "{label}");
        assert_eq!(committed(), committed_record, "{label}");
    }
    // One that is not a private regular file of this user is not even read.
    fs::set_permissions(&pool.pending, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        with_pool(&fixture, recover).unwrap_err().code,
        "foreign_state"
    );
    assert!(pool.pending.exists());
    // A committed record copied from another pool is refused as well.
    fs::remove_file(&pool.pending).unwrap();
    fs::write(&pool.record, serde_json::to_vec(&other_pool).unwrap()).unwrap();
    assert_eq!(
        with_pool(&fixture, recover).unwrap_err().code,
        "prepared_base_invalid"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn consumption_follows_the_first_start_and_removes_only_the_recorded_clones() {
    let fixture = Fixture::new("consume");
    let base = fixture.base();
    let pool = fixture.pool();
    with_pool(&fixture, |target| activate(&base, &pins(), target)).unwrap();

    // Before the first start SmolVM has not cloned them yet.
    assert_eq!(
        with_pool(&fixture, consume).unwrap_err().code,
        "prepared_base_recovery_required"
    );
    assert_eq!(fixture.entries(&pool.templates).len(), 2);

    // A template replaced after activation is not this activation's to remove.
    for disk in &pool.disks {
        fs::write(disk, b"").unwrap();
    }
    let replaced = pool.templates.join(TEMPLATES[0]);
    fs::remove_file(&replaced).unwrap();
    fs::write(&replaced, b"replaced").unwrap();
    assert_eq!(
        with_pool(&fixture, consume).unwrap_err().code,
        "foreign_state"
    );
    assert_eq!(fixture.entries(&pool.templates).len(), 2);
    fs::remove_file(&replaced).unwrap();

    with_pool(&fixture, consume).unwrap();
    assert!(fixture.entries(&pool.templates).is_empty());
    let record = ActivationRecord::load_path(&pool.record);
    assert_eq!(record.state, ActivationState::Consumed);
    // Idempotent, and the pool stays bound for its network-tools owner.
    with_pool(&fixture, consume).unwrap();
    assert_eq!(
        network_tools_owner(Some(&record), "token"),
        "prepared-base:base-1"
    );
    assert_eq!(with_pool(&fixture, recover).unwrap(), Recovery::Nothing);
}

#[cfg(target_os = "macos")]
impl ActivationRecord {
    /// The committed record at `path`, for assertions outside a pool operation.
    fn load_path(path: &Path) -> Self {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }
}
