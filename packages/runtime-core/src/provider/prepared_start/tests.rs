use super::*;
#[cfg(target_os = "macos")]
use crate::provider::Profile;
#[cfg(target_os = "macos")]
use crate::provider::prepared_base::{PublishRequest, PublishedBase, Sanitization};
#[cfg(target_os = "macos")]
use crate::provider::prepared_store::{Inventory, VERIFICATION_SCHEMA, Verification};
#[cfg(target_os = "macos")]
use std::os::unix::fs::FileExt;
use std::os::unix::fs::PermissionsExt;

const ROOTFS: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN: &str = "0123456789abcdef0123456789abcdef";

struct Fixture {
    checkout: PathBuf,
    candidate: Candidate,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let mut random = [0_u8; 8];
        File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut random)
            .unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let checkout = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hack-prepared-start-{label}-{suffix}"));
        fs::create_dir(&checkout).unwrap();
        let candidate = Candidate::discover(&checkout).unwrap();
        state::private_directory(&root(&candidate).join(TEMPLATE_DIR)).unwrap();
        state::private_directory(&checkout.join("store")).unwrap();
        state::private_directory(&checkout.join("seed")).unwrap();
        Self {
            checkout,
            candidate,
        }
    }

    fn store(&self) -> PathBuf {
        self.checkout.join("store")
    }

    fn request(&self, mode: Mode) -> Request {
        Request {
            mode,
            store: self.store(),
        }
    }

    fn templates(&self) -> PathBuf {
        root(&self.candidate).join(TEMPLATE_DIR)
    }

    /// Publish and independently "verify" a small base bound to this fixture's pins.
    #[cfg(target_os = "macos")]
    fn verified_base(&self, base_id: &str, verified: bool) -> PublishedBase {
        let capacity = [
            u64::from(Profile::Research.storage_gib()) << 30,
            u64::from(Profile::Research.overlay_gib()) << 30,
        ];
        let seeds: Vec<PathBuf> = ["storage", "overlay"]
            .iter()
            .zip(capacity)
            .map(|(kind, len)| {
                let path = self.checkout.join("seed").join(format!("{base_id}-{kind}"));
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
                pins: Pins::current(Profile::Research, ROOTFS),
                sources: [&seeds[0], &seeds[1]],
                sanitization: Sanitization::sanitized(),
            },
        )
        .unwrap();
        let base = prepared_base::open_published(&self.store(), base_id).unwrap();
        if verified {
            let exclusive = StoreLock::exclusive(&self.store()).unwrap();
            prepared_store::record_verification(
                &self.store(),
                &exclusive,
                &Verification {
                    schema: VERIFICATION_SCHEMA.into(),
                    base_id: base_id.into(),
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
                    verified_at_unix: 1,
                },
            )
            .unwrap();
        }
        base
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.checkout);
    }
}

/// A pool owner as the lifecycle holds it before (or after) disk adoption.
fn owner(adopted: bool) -> Owner {
    let disk = serde_json::json!({"device": 1, "inode": 2, "bytes": 3, "uuid": "fixture"});
    let disk = if adopted {
        disk
    } else {
        serde_json::Value::Null
    };
    serde_json::from_value(serde_json::json!({
        "version": 1, "checkout": "/fixture", "token": TOKEN, "machine": "fixture",
        "short_home": "/fixture", "created": adopted, "phase": "creating",
        "process": null, "storage": disk, "overlay": disk, "guest_boot_id": null,
        "daemon_pid": null, "daemon_start": null, "rootfs_digest": ROOTFS,
        "profile": "research"
    }))
    .unwrap()
}

fn lock(fixture: &Fixture) -> state::Lock {
    state::Lock::acquire(&root(&fixture.candidate)).unwrap()
}

#[test]
fn modes_parse_exactly() {
    assert_eq!(Mode::parse("prefer"), Some(Mode::Prefer));
    assert_eq!(Mode::parse("require"), Some(Mode::Require));
    assert_eq!(Mode::parse("off"), None);
    assert_eq!(Mode::parse("Prefer"), None);
}

#[test]
fn no_request_keeps_the_stock_path_and_clears_a_stale_selection() {
    let fixture = Fixture::new("none");
    let lock = lock(&fixture);
    write_selection(
        &fixture.candidate,
        &Selection {
            mode: Mode::Prefer,
            source: Source::Stock,
            base_id: None,
            reason: Some("stale".into()),
            consume_error: None,
        },
    )
    .unwrap();
    before_create(&fixture.candidate, &owner(false), &lock, None).unwrap();
    assert!(status(&fixture.candidate).is_none());
    assert_eq!(
        network_tools_owner(&fixture.candidate, &owner(false), &lock).unwrap(),
        TOKEN
    );
}

#[test]
fn prefer_falls_back_with_a_typed_reason_and_require_refuses() {
    let fixture = Fixture::new("fallback");
    let lock = lock(&fixture);
    // An empty store has no verified base for these pins.
    let prefer = fixture.request(Mode::Prefer);
    before_create(&fixture.candidate, &owner(false), &lock, Some(&prefer)).unwrap();
    let selection = status(&fixture.candidate).unwrap().selection.unwrap();
    assert_eq!(selection.source, Source::Stock);
    assert_eq!(
        selection.reason.as_deref(),
        Some("no_verified_base_for_pins")
    );
    let require = fixture.request(Mode::Require);
    let refused =
        before_create(&fixture.candidate, &owner(false), &lock, Some(&require)).unwrap_err();
    assert_eq!(refused.code, "prepared_base_unavailable");
    // A missing store is a store reason, not a pool failure.
    let missing = Request {
        mode: Mode::Prefer,
        store: fixture.checkout.join("absent-store"),
    };
    before_create(&fixture.candidate, &owner(false), &lock, Some(&missing)).unwrap();
    let reason = status(&fixture.candidate)
        .unwrap()
        .selection
        .unwrap()
        .reason
        .unwrap();
    assert!(reason.starts_with("store:"), "{reason}");
    assert!(fs::read_dir(fixture.templates()).unwrap().next().is_none());
}

#[test]
fn unowned_templates_fall_back_in_prefer_and_refuse_in_require() {
    let fixture = Fixture::new("unowned");
    let lock = lock(&fixture);
    fs::write(
        fixture.templates().join(TEMPLATES[0]),
        b"not a stock expansion",
    )
    .unwrap();
    // Prefer keeps the stock path, whose own check refuses a template it cannot verify.
    let refused = before_create(
        &fixture.candidate,
        &owner(false),
        &lock,
        Some(&fixture.request(Mode::Prefer)),
    )
    .unwrap_err();
    assert_eq!(refused.code, "disk_template_untrusted");
    assert_eq!(
        status(&fixture.candidate)
            .unwrap()
            .selection
            .unwrap()
            .reason
            .as_deref(),
        Some("stock_templates_present")
    );
    let refused = before_create(
        &fixture.candidate,
        &owner(false),
        &lock,
        Some(&fixture.request(Mode::Require)),
    )
    .unwrap_err();
    assert_eq!(refused.code, "prepared_base_unavailable");
    assert_eq!(
        fs::read(fixture.templates().join(TEMPLATES[0])).unwrap(),
        b"not a stock expansion"
    );
}

#[test]
fn an_unprovable_interrupted_record_refuses_even_in_prefer() {
    let fixture = Fixture::new("torn");
    let lock = lock(&fixture);
    let pending = root(&fixture.candidate).join("prepared-base.json.pending");
    fs::write(&pending, b"{\"schema\":\"hack.prepared-base-act").unwrap();
    fs::set_permissions(&pending, fs::Permissions::from_mode(0o600)).unwrap();
    let refused = before_create(
        &fixture.candidate,
        &owner(false),
        &lock,
        Some(&fixture.request(Mode::Prefer)),
    )
    .unwrap_err();
    assert_eq!(refused.code, "prepared_base_recovery_required");
    assert!(pending.exists());
}

#[test]
fn a_seed_marker_is_bound_to_its_own_state_root() {
    let fixture = Fixture::new("seed");
    let lock = lock(&fixture);
    write_seed_marker(&fixture.candidate, "base-1").unwrap();
    assert_eq!(
        network_tools_owner(&fixture.candidate, &owner(false), &lock).unwrap(),
        "prepared-base:base-1"
    );
    // A marker naming another state root is refused, not honored.
    write_private(
        &root(&fixture.candidate).join(SEED),
        &SeedMarker {
            base_id: "base-1".into(),
            state_root: PathBuf::from("/elsewhere/.hack-local"),
        },
    )
    .unwrap();
    assert_eq!(
        network_tools_owner(&fixture.candidate, &owner(false), &lock)
            .unwrap_err()
            .code,
        "foreign_state"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn a_verified_base_is_activated_checked_owned_and_consumed_after_adoption() {
    let fixture = Fixture::new("bound");
    fixture.verified_base("base-1", true);
    let lock = lock(&fixture);
    let fresh = owner(false);
    let request = fixture.request(Mode::Require);
    before_create(&fixture.candidate, &fresh, &lock, Some(&request)).unwrap();
    let reported = status(&fixture.candidate).unwrap();
    assert_eq!(reported.selection.unwrap().source, Source::Prepared);
    assert_eq!(reported.activation, Some(ActivationState::Activated));
    // A bound pool is checked against its receipt at both points, never the stock pins.
    verify(&fixture.candidate, &fresh, &lock, Stage::BeforeUse).unwrap();
    verify(&fixture.candidate, &fresh, &lock, Stage::AfterFirstStart).unwrap();
    assert!(
        disk_template::verify_expanded(&fixture.templates(), Stage::BeforeUse).is_err(),
        "the stock pins refuse a base"
    );
    assert_eq!(
        network_tools_owner(&fixture.candidate, &fresh, &lock).unwrap(),
        "prepared-base:base-1"
    );
    // The first start formats the disks; the lifecycle then adopts them and consumes.
    let data = fresh.real_data_dir(&fixture.candidate).unwrap();
    state::private_directory(&data).unwrap();
    for name in ["storage.raw", "overlay.raw"] {
        fs::write(data.join(name), b"").unwrap();
    }
    let adopted = owner(true);
    after_adoption(&fixture.candidate, &adopted, &lock);
    let reported = status(&fixture.candidate).unwrap();
    assert_eq!(reported.activation, Some(ActivationState::Consumed));
    assert_eq!(reported.selection.unwrap().consume_error, None);
    assert!(fs::read_dir(fixture.templates()).unwrap().next().is_none());
    // Adopted pools no longer depend on templates; the pool stays bound for its tools owner.
    verify(&fixture.candidate, &adopted, &lock, Stage::BeforeUse).unwrap();
    assert_eq!(
        network_tools_owner(&fixture.candidate, &adopted, &lock).unwrap(),
        "prepared-base:base-1"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn an_unverified_base_is_never_used() {
    let fixture = Fixture::new("unverified");
    fixture.verified_base("base-1", false);
    let lock = lock(&fixture);
    before_create(
        &fixture.candidate,
        &owner(false),
        &lock,
        Some(&fixture.request(Mode::Prefer)),
    )
    .unwrap();
    let reported = status(&fixture.candidate).unwrap();
    assert_eq!(reported.activation, None);
    assert_eq!(
        reported.selection.unwrap().reason.as_deref(),
        Some("no_verified_base_for_pins")
    );
    assert!(fs::read_dir(fixture.templates()).unwrap().next().is_none());
}
