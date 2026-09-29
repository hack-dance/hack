use super::*;
#[cfg(target_os = "macos")]
use crate::provider::Profile;
#[cfg(target_os = "macos")]
use crate::provider::prepared_base::{PublishRequest, Sanitization};
use std::io::Read;
#[cfg(target_os = "macos")]
use std::os::unix::fs::FileExt;

#[cfg(target_os = "macos")]
const ROOTFS: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[cfg(target_os = "macos")]
fn pins() -> Pins {
    Pins::current(Profile::Research, ROOTFS)
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let mut random = [0_u8; 8];
        File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut random)
            .unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hack-prepared-store-{label}-{suffix}"));
        state::private_directory(&root.join("store")).unwrap();
        state::private_directory(&root.join("seed")).unwrap();
        Self { root }
    }

    fn store(&self) -> PathBuf {
        self.root.join("store")
    }

    /// Publish a small synthetic base at the Research capacity.
    #[cfg(target_os = "macos")]
    fn publish(&self, base_id: &str) -> PublishedBase {
        let capacity = [
            u64::from(Profile::Research.storage_gib()) << 30,
            u64::from(Profile::Research.overlay_gib()) << 30,
        ];
        let seeds: Vec<PathBuf> = ["storage", "overlay"]
            .iter()
            .zip(capacity)
            .map(|(kind, len)| {
                let path = self.root.join("seed").join(format!("{base_id}-{kind}"));
                let file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&path)
                    .unwrap();
                file.write_all_at(kind.as_bytes(), 0).unwrap();
                file.set_len(len).unwrap();
                path
            })
            .collect();
        prepared_base::publish(
            &self.store(),
            &PublishRequest {
                base_id,
                pins: pins(),
                sources: [&seeds[0], &seeds[1]],
                sanitization: Sanitization::sanitized(),
            },
        )
        .unwrap();
        prepared_base::open_published(&self.store(), base_id).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// A passing verification of `base`, observed at `at`.
#[cfg(target_os = "macos")]
fn passing(base: &PublishedBase, at: u64) -> Verification {
    Verification {
        schema: VERIFICATION_SCHEMA.into(),
        base_id: base.receipt.base_id.clone(),
        receipt_sha256: base.receipt_sha256.clone(),
        template_sha256: base
            .receipt
            .templates
            .iter()
            .map(|template| template.content_sha256.clone())
            .collect(),
        inventory: Inventory {
            owner_marker_present: false,
            engine_id_present: false,
            containers: 0,
            volumes: 0,
            network_tools_owner: base.receipt.network_tools_owner.clone(),
            network_tools_identity: base.receipt.pins.network_tools_identity.clone(),
            network_tools_files_verified: true,
            images: Vec::new(),
            unexpected: Vec::new(),
        },
        verified_at_unix: at,
    }
}

#[test]
fn a_store_lock_is_shared_or_exclusive_never_both() {
    let fixture = Fixture::new("lock");
    let store = fixture.store();
    let first = StoreLock::shared(&store).unwrap();
    let second = StoreLock::shared(&store).unwrap();
    assert_eq!(
        StoreLock::exclusive(&store).err().unwrap().code,
        "prepared_base_store_busy"
    );
    drop((first, second));
    let exclusive = StoreLock::exclusive(&store).unwrap();
    assert_eq!(
        StoreLock::shared(&store).err().unwrap().code,
        "prepared_base_store_busy"
    );
    drop(exclusive);
    StoreLock::shared(&store).unwrap();
    assert_eq!(
        StoreLock::shared(Path::new("relative")).err().unwrap().code,
        "prepared_base_invalid"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn a_verification_accepts_only_a_passing_inventory_of_that_exact_base() {
    let fixture = Fixture::new("accepts");
    let base = fixture.publish("base-1");
    assert!(passing(&base, 1).accepts(&base));
    let cases: [fn(&mut Verification); 11] = [
        |v| v.schema = "other".into(),
        |v| v.base_id = "base-2".into(),
        |v| v.receipt_sha256 = "0".repeat(64),
        |v| v.template_sha256[1] = "0".repeat(64),
        |v| v.inventory.owner_marker_present = true,
        |v| v.inventory.engine_id_present = true,
        |v| v.inventory.containers = 1,
        |v| v.inventory.volumes = 1,
        |v| v.inventory.network_tools_owner = "0".repeat(32),
        |v| v.inventory.network_tools_files_verified = false,
        |v| v.inventory.unexpected = vec!["overlay:root/.docker/config.json".into()],
    ];
    for (index, mutate) in cases.into_iter().enumerate() {
        let mut verification = passing(&base, 1);
        mutate(&mut verification);
        assert!(!verification.accepts(&base), "case {index}");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn selection_picks_the_newest_verified_base_bound_to_the_pins() {
    let fixture = Fixture::new("select");
    let store = fixture.store();
    let older = fixture.publish("base-older");
    let newer = fixture.publish("base-newer");
    fixture.publish("base-unverified");
    assert!(select(&store, &pins()).unwrap().is_none());
    {
        let exclusive = StoreLock::exclusive(&store).unwrap();
        record_verification(&store, &exclusive, &passing(&older, 100)).unwrap();
        record_verification(&store, &exclusive, &passing(&newer, 200)).unwrap();
    }
    assert_eq!(
        select(&store, &pins()).unwrap().unwrap().receipt.base_id,
        "base-newer"
    );
    // Other pins bind nothing.
    assert!(
        select(&store, &Pins::current(Profile::Development, ROOTFS))
            .unwrap()
            .is_none()
    );
    let listed = entries(&store, &pins()).unwrap();
    let unverified = listed
        .iter()
        .find(|entry| entry.base_id == "base-unverified")
        .unwrap();
    assert!(!unverified.verified && unverified.matches_pins);
    // A failing recorded verification is not eligible.
    {
        let exclusive = StoreLock::exclusive(&store).unwrap();
        let mut failing = passing(&newer, 300);
        failing.inventory.unexpected = vec!["storage:hack-graph-startup".into()];
        record_verification(&store, &exclusive, &failing).unwrap();
    }
    assert_eq!(
        select(&store, &pins()).unwrap().unwrap().receipt.base_id,
        "base-older"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn removal_takes_the_base_and_its_verification_and_nothing_else() {
    let fixture = Fixture::new("remove");
    let store = fixture.store();
    let base = fixture.publish("base-1");
    let exclusive = StoreLock::exclusive(&store).unwrap();
    record_verification(&store, &exclusive, &passing(&base, 1)).unwrap();
    std::os::unix::fs::symlink(store.join("base-1"), store.join("base-alias")).unwrap();
    assert_eq!(
        remove(&store, &exclusive, "base-alias").unwrap_err().code,
        "foreign_state"
    );
    remove(&store, &exclusive, "base-1").unwrap();
    assert!(!store.join("base-1").exists());
    assert!(!store.join(VERIFIED).join("base-1.json").exists());
    assert!(fs::symlink_metadata(store.join("base-alias")).is_ok());
    assert_eq!(
        remove(&store, &exclusive, "Bad-Id").unwrap_err().code,
        "prepared_base_invalid"
    );
}
