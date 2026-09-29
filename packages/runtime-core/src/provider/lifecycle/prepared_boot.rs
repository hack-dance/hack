//! Seed builds and independent verification boots for prepared bases.
//!
//! Both run in a disposable state root at `<store>/.work/<nonce>` holding APFS clones of this
//! candidate's verified providers, so they never touch the user's pool, home or providers:
//! - **Seed.** An ordinary fresh pool (stock templates; no project share, sockets, graphs, images
//!   or credentials) whose network tools are installed under the base-scoped owner. Once it is
//!   running, a reviewed guest script proves it has no containers or volumes, stops the engine,
//!   removes per-pool identity and syncs; the provider then stops the machine. The stopped disks
//!   are published under the exclusive store lock.
//! - **Verifier.** Activates the published base into its own fresh pool (re-proving the content
//!   digests on its own clone), starts it, and before any guest setup reads both disks with a
//!   read-only script. `prepared_inventory` evaluates that report against allow-lists; only a
//!   passing inventory is recorded as the base's verification. The publisher's sanitization
//!   record is never evidence.
//!
//! Teardown deletes only the work root's own machine (named by its owner receipt, inside the
//! root's private provider home), its short-HOME alias, and the root. If teardown fails the
//! root is kept and reported for inspection.
use super::super::prepared_base::{self, Pins, PoolTarget, PublishRequest, Receipt, Sanitization};
use super::super::prepared_store::{self, Entry, StoreLock, Verification};
use super::super::{Profile, artifact, identity, prepared_inventory, prepared_start};
use super::{Owner, agent, guest, invoke, prepare_rootfs, recorded_process, root, socket, state};
use crate::{Candidate, CandidateError};
use serde::Serialize;
use std::fs::{self, File};
use std::io::Read;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn error(code: &'static str, message: impl Into<String>) -> CandidateError {
    CandidateError::new(code, message)
}

fn random_hex() -> Result<String, CandidateError> {
    let mut bytes = [0_u8; 16];
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut bytes))
        .map_err(state::io)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// The profile whose disk capacity a base was built for.
fn profile_for(pins: &Pins) -> Result<Profile, CandidateError> {
    [Profile::Research, Profile::Development]
        .into_iter()
        .find(|profile| {
            profile.storage_gib() == pins.storage_gib && profile.overlay_gib() == pins.overlay_gib
        })
        .ok_or_else(|| {
            error(
                "prepared_base_capacity",
                "The base's capacity matches no candidate profile.",
            )
        })
}

fn current_pins(candidate: &Candidate, profile: Profile) -> Result<Pins, CandidateError> {
    let rootfs = artifact::rootfs_digest(&artifact::root(candidate).join("agent-rootfs"), None)?;
    Ok(Pins::current(profile, &rootfs))
}

/// A disposable state root for one seed build or verification.
struct Work {
    dir: PathBuf,
    candidate: Candidate,
}

impl Work {
    fn create(candidate: &Candidate, store: &Path) -> Result<Self, CandidateError> {
        prepared_store::open(store)?;
        let parent = store.join(".work");
        state::private_directory(&parent)?;
        let dir = parent.join(random_hex()?);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(state::io)?;
        let state_root = dir.join(".hack-local");
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&state_root)
            .map_err(state::io)?;
        // Artifact receipts pin archives and tree digests, not paths; startup re-verifies them.
        prepared_base::clone_file(
            &candidate.state_root.join("providers"),
            &state_root.join("providers"),
        )?;
        let candidate = Candidate::discover(&dir)?;
        Ok(Self { dir, candidate })
    }

    /// Delete this root's machine, alias and directory. Returns the kept root on failure.
    fn teardown(&self) -> Result<(), CandidateError> {
        let receipt = root(&self.candidate).join("owner.json");
        if fs::symlink_metadata(&receipt).is_ok() {
            let owner = Owner::load(&self.candidate)?;
            if owner.created {
                invoke(
                    &self.candidate,
                    &owner,
                    &["machine", "delete", "--name", &owner.machine, "--force"],
                )?;
            }
            // `Owner::load` proved the alias points at this root's home.
            fs::remove_file(&owner.short_home).map_err(state::io)?;
        }
        fs::remove_dir_all(&self.dir).map_err(state::io)
    }

    fn finish<T>(self, outcome: Result<T, CandidateError>) -> Result<(T, bool), CandidateError> {
        match (outcome, self.teardown()) {
            (Ok(value), Ok(())) => Ok((value, true)),
            (Ok(value), Err(_)) => Ok((value, false)),
            (Err(failure), Ok(())) => Err(failure),
            (Err(failure), Err(cleanup)) => Err(error(
                failure.code,
                format!(
                    "{} Cleanup also failed ({}: {}); the work root was kept at {}.",
                    failure.message,
                    cleanup.code,
                    cleanup.message,
                    self.dir.display()
                ),
            )),
        }
    }
}

/// Ask the provider to stop the machine and wait for its verified process to exit.
fn stop(candidate: &Candidate, owner: &Owner) -> Result<(), CandidateError> {
    let process = owner.process.as_ref().ok_or_else(|| {
        error(
            "process_identity_unavailable",
            "No retained provider identity.",
        )
    })?;
    invoke(
        candidate,
        owner,
        &["machine", "stop", "--name", &owner.machine],
    )?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while identity::alive(process.pid)? {
        if Instant::now() >= deadline {
            return Err(error(
                "stop_uncertain",
                "The provider did not stop within 60 seconds.",
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

/// A published base and whether its work root was removed.
#[derive(Debug, Serialize)]
pub struct Built {
    pub receipt: Receipt,
    pub work_removed: bool,
}

/// Build and publish a base for `profile` into `store` (created private if missing).
pub fn build_prepared_base(
    candidate: &Candidate,
    store: &Path,
    profile: Profile,
    base_id: Option<&str>,
) -> Result<Built, CandidateError> {
    state::private_directory(store)?;
    let base_id = match base_id {
        Some(id) if prepared_base::valid_base_id(id) => id.to_string(),
        Some(_) => {
            return Err(error(
                "prepared_base_invalid",
                "A base id is 1-64 lowercase letters, digits or hyphens.",
            ));
        }
        None => {
            let label = match profile {
                Profile::Research => "research",
                Profile::Development => "development",
            };
            format!("{label}-{}", &random_hex()?[..12])
        }
    };
    if fs::symlink_metadata(store.join(&base_id)).is_ok() {
        return Err(error(
            "prepared_base_exists",
            format!("Prepared base {base_id} already exists; it was not changed."),
        ));
    }
    let work = Work::create(candidate, store)?;
    let outcome = seed(&work.candidate, store, profile, &base_id);
    let (receipt, work_removed) = work.finish(outcome)?;
    Ok(Built {
        receipt,
        work_removed,
    })
}

fn seed(
    seed: &Candidate,
    store: &Path,
    profile: Profile,
    base_id: &str,
) -> Result<Receipt, CandidateError> {
    prepared_start::write_seed_marker(seed, base_id)?;
    super::up_with_profile(seed, profile)?;
    let owner = Owner::load(seed)?;
    {
        let _lock = state::Lock::acquire(&root(seed))?;
        let boot = owner
            .guest_boot_id
            .clone()
            .ok_or_else(|| error("guest_protocol", "The seed has no boot identity."))?;
        let sanitized = guest(
            seed,
            &owner,
            include_str!("../guest-seed-sanitize.sh"),
            &[&owner.token, &boot],
            false,
        )?;
        if sanitized != "prepared-seed-sanitized-v1\n" {
            return Err(error(
                "prepared_base_invalid",
                "The seed's sanitization was not confirmed.",
            ));
        }
        stop(seed, &owner)?;
    }
    let dir = owner.real_data_dir(seed)?;
    let (storage, overlay) = (dir.join("storage.raw"), dir.join("overlay.raw"));
    let rootfs = owner.rootfs_digest.as_deref().ok_or_else(|| {
        error(
            "prepared_base_invalid",
            "The seed's rootfs digest is not recorded.",
        )
    })?;
    let _exclusive = StoreLock::exclusive(store)?;
    prepared_base::publish(
        store,
        &PublishRequest {
            base_id,
            pins: Pins::current(profile, rootfs),
            sources: [&storage, &overlay],
            // A publisher claim the seed script enforced; `verify_prepared_base` proves it.
            sanitization: Sanitization::sanitized(),
        },
    )
}

/// Independently verify a published base and, if it passes, record the verification.
pub fn verify_prepared_base(
    candidate: &Candidate,
    store: &Path,
    base_id: &str,
) -> Result<Verification, CandidateError> {
    let base = prepared_base::open_published(store, base_id)?;
    let profile = profile_for(&base.receipt.pins)?;
    base.bind(&current_pins(candidate, profile)?)?;
    let work = Work::create(candidate, store)?;
    let outcome = inspect(&work.candidate, store, &base, profile);
    let (inventory, _) = work.finish(outcome)?;
    let verification = Verification {
        schema: prepared_store::VERIFICATION_SCHEMA.into(),
        base_id: base.receipt.base_id.clone(),
        receipt_sha256: base.receipt_sha256.clone(),
        template_sha256: base
            .receipt
            .templates
            .iter()
            .map(|template| template.content_sha256.clone())
            .collect(),
        inventory,
        verified_at_unix: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or_default(),
    };
    if !verification.accepts(&base) {
        return Err(error(
            "prepared_base_unverified",
            format!(
                "Prepared base {base_id} failed independent verification: {}",
                serde_json::to_string(&verification.inventory).unwrap_or_default()
            ),
        ));
    }
    let exclusive = StoreLock::exclusive(store)?;
    prepared_store::record_verification(store, &exclusive, &verification)?;
    Ok(verification)
}

fn inspect(
    verifier: &Candidate,
    store: &Path,
    base: &prepared_base::PublishedBase,
    profile: Profile,
) -> Result<prepared_store::Inventory, CandidateError> {
    let admission = super::super::admission::probe_for(&verifier.checkout, profile)?;
    if !admission.admitted {
        return Err(error("admission_rejected", admission.reasons.join(" ")));
    }
    artifact::verify(verifier)?;
    let mut owner = Owner::create_with_project_share(
        verifier,
        profile,
        None,
        super::super::NetworkIntent::default(),
        None,
        None,
    )?;
    let lock = state::Lock::acquire(&root(verifier))?;
    prepare_rootfs(verifier, &mut owner)?;
    let rootfs = owner
        .rootfs_digest
        .clone()
        .ok_or_else(|| error("prepared_base_invalid", "No verifier rootfs digest."))?;
    let pins = Pins::current(profile, &rootfs);
    let dir = owner.real_data_dir(verifier)?;
    let disks = [dir.join("storage.raw"), dir.join("overlay.raw")];
    let pool_root = root(verifier);
    let target = PoolTarget::new(&pool_root, &lock, [&disks[0], &disks[1]])?;
    {
        let _shared = StoreLock::shared(store)?;
        // Re-proves every template's content digest on this verifier's own clone.
        prepared_base::activate(base, &pins, &target)?;
    }
    owner.phase = "creating".into();
    owner.save(verifier)?;
    let mut create = vec![
        "machine".to_owned(),
        "create".into(),
        "--name".into(),
        owner.machine.clone(),
        "--label".into(),
        format!("hack-local.owner={}", owner.token),
        "--cpus".into(),
        "1".into(),
        "--mem".into(),
        "1024".into(),
        "--storage".into(),
        profile.storage_gib().to_string(),
        "--overlay".into(),
        profile.overlay_gib().to_string(),
    ];
    create.extend(
        owner
            .network
            .arguments()
            .iter()
            .map(|value| (*value).to_owned()),
    );
    invoke(
        verifier,
        &owner,
        &create.iter().map(String::as_str).collect::<Vec<_>>(),
    )?;
    owner.created = true;
    owner.phase = "verifying".into();
    owner.save(verifier)?;
    invoke(
        verifier,
        &owner,
        &["machine", "start", "--name", &owner.machine],
    )?;
    let observed = recorded_process(verifier, &owner)?;
    // SAFETY: geteuid has no preconditions and cannot fail.
    identity::verify(
        &observed,
        &identity::observe(observed.pid)?,
        &super::binary(verifier),
        unsafe { libc::geteuid() },
    )?;
    owner.process = Some(observed);
    owner.save(verifier)?;
    let inspected = (|| {
        // The first start cloned the activated templates; they must still be the verified clones.
        prepared_base::verify_activated(&target)?;
        let storage = identity::disk(&disks[0])?;
        let overlay = identity::disk(&disks[1])?;
        super::verify_disk_allocation(&storage, &overlay, profile)?;
        owner.storage = Some(storage);
        owner.overlay = Some(overlay);
        owner.save(verifier)?;
        agent::ping(&socket(verifier, &owner, "agent.sock")?)?;
        guest(
            verifier,
            &owner,
            include_str!("../guest-prepared-inventory.sh"),
            &[],
            false,
        )
    })();
    let stopped = stop(verifier, &owner);
    let report = inspected?;
    stopped?;
    prepared_inventory::evaluate(&report, &[])
}

/// Every base in `store`, with whether it is published, verified and bound to this candidate's
/// pins for `profile`.
pub fn prepared_base_status(
    candidate: &Candidate,
    store: &Path,
    profile: Profile,
) -> Result<Vec<Entry>, CandidateError> {
    prepared_store::entries(store, &current_pins(candidate, profile)?)
}

/// Remove one base and its verification under the exclusive store lock.
pub fn remove_prepared_base(store: &Path, base_id: &str) -> Result<(), CandidateError> {
    let exclusive = StoreLock::exclusive(store)?;
    prepared_store::remove(store, &exclusive, base_id)
}
