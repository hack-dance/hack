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
//! root's private provider home), its short-HOME alias, and the root, and only once no process
//! executes the root's provider. If teardown fails the root is kept and reported for inspection.
//!
//! Each work root holds an exclusive lock (`work.lock`, taken before anything else is created in
//! it) for as long as its creating process lives; the kernel releases it when that process ends,
//! however it ends. A root whose lock is free was therefore abandoned by an interrupted build or
//! verification. `status` lists such roots; `build` and `verify` first tear them down under their
//! lock (a root still holding a provider is kept). Nothing whose lock is held, or that is not a
//! work root, is touched.
use super::super::prepared_base::{self, Pins, PoolTarget, PublishRequest, Receipt, Sanitization};
use super::super::prepared_store::{self, Entry, StoreLock, Verification};
use super::super::{Profile, artifact, identity, prepared_inventory, prepared_start};
use super::{
    Owner, agent, binary, guest, invoke, prepare_rootfs, recorded_process, root, socket, state,
};
use crate::{Candidate, CandidateError};
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
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

const WORK: &str = ".work";
const WORK_LOCK: &str = "work.lock";

/// Open (or with `create`, exclusively create) `dir`'s work lock and take it without waiting.
/// `None` when a live process holds it.
fn lock_work(dir: &Path, create: bool) -> Result<Option<File>, CandidateError> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .mode(0o600);
    if create {
        options.create_new(true);
    }
    let file = options.open(dir.join(WORK_LOCK)).map_err(state::io)?;
    let metadata = file.metadata().map_err(state::io)?;
    // SAFETY: geteuid has no preconditions and cannot fail.
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(error("foreign_state", "Unsafe prepared-base work lock."));
    }
    // SAFETY: the descriptor is owned by `file` and open for the duration of the call.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(file));
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::EWOULDBLOCK) => Ok(None),
        _ => Err(error(
            "prepared_base_store_busy",
            "Cannot establish whether a work root is in use.",
        )),
    }
}

/// A disposable state root for one seed build or verification.
struct Work {
    dir: PathBuf,
    candidate: Candidate,
    /// Held for the root's lifetime; its release marks the root abandoned.
    _lock: File,
}

impl Work {
    fn create(candidate: &Candidate, store: &Path) -> Result<Self, CandidateError> {
        prepared_store::open(store)?;
        let parent = store.join(WORK);
        state::private_directory(&parent)?;
        let dir = parent.join(random_hex()?);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(state::io)?;
        let lock = lock_work(&dir, true)?
            .ok_or_else(|| error("prepared_base_store_busy", "A new work root was locked."))?;
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
        Ok(Self {
            dir,
            candidate,
            _lock: lock,
        })
    }

    /// Delete this root's machine, alias and directory. Returns the kept root on failure.
    fn teardown(&self) -> Result<(), CandidateError> {
        let receipt = root(&self.candidate).join("owner.json");
        if fs::symlink_metadata(&receipt).is_ok() {
            match Owner::load(&self.candidate) {
                Ok(owner) => {
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
                Err(failure) => {
                    // The receipt is saved just before its alias is created, and nothing external
                    // happens before both exist. A receipt without an alias and without a created
                    // machine therefore left nothing outside this root.
                    let owner: Owner = state::read(&receipt)?;
                    let alias_absent = matches!(
                        fs::symlink_metadata(&owner.short_home),
                        Err(missing) if missing.kind() == ErrorKind::NotFound
                    );
                    if owner.created || !alias_absent || owner.checkout != self.candidate.checkout {
                        return Err(failure);
                    }
                }
            }
        }
        // Deleting the machine stops its provider; nothing is removed while one still runs.
        if identity::executable_running(&binary(&self.candidate))? {
            return Err(error(
                "stop_uncertain",
                "A provider still runs in the work root; it was kept.",
            ));
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

/// A work root whose creating process is gone.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct AbandonedWork {
    /// The root's name under `<store>/.work`.
    pub root: String,
    pub removed: bool,
    /// Why it was kept, when recovery was attempted and refused.
    pub kept: Option<String>,
}

/// Find, and with `remove` tear down, work roots abandoned by interrupted builds or
/// verifications. A root is abandoned only when its lock is free, or it is still empty (its
/// creator stopped before taking the lock). Other entries are reported and never touched.
fn abandoned_work(store: &Path, remove: bool) -> Result<Vec<AbandonedWork>, CandidateError> {
    let parent = store.join(WORK);
    match fs::symlink_metadata(&parent) {
        Err(missing) if missing.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(failure) => return Err(state::io(failure)),
        Ok(_) => state::private_directory(&parent)?,
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(&parent).map_err(state::io)? {
        names.push(entry.map_err(state::io)?.file_name());
    }
    names.sort();
    let mut found = Vec::new();
    for name in names {
        let label = name.to_string_lossy().into_owned();
        let kept = |reason: &str| AbandonedWork {
            root: label.clone(),
            removed: false,
            kept: Some(reason.into()),
        };
        let dir = parent.join(&name);
        let metadata = fs::symlink_metadata(&dir).map_err(state::io)?;
        // SAFETY: geteuid has no preconditions and cannot fail.
        let own = metadata.is_dir() && metadata.uid() == unsafe { libc::geteuid() };
        let named = label.len() == 32
            && label
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        if !own || !named {
            found.push(kept("foreign_state"));
            continue;
        }
        if let Err(missing) = fs::symlink_metadata(dir.join(WORK_LOCK))
            && missing.kind() == ErrorKind::NotFound
        {
            // The lock is created before anything else, so only an empty root may lack it.
            if fs::read_dir(&dir).map_err(state::io)?.next().is_some() {
                found.push(kept("work_lock_missing"));
                continue;
            }
            if remove {
                fs::remove_dir(&dir).map_err(state::io)?;
            }
            found.push(AbandonedWork {
                root: label,
                removed: remove,
                kept: None,
            });
            continue;
        }
        let lock = match lock_work(&dir, false) {
            Ok(Some(lock)) => lock,
            // A live build or verification.
            Ok(None) => continue,
            Err(failure) => {
                found.push(kept(failure.code));
                continue;
            }
        };
        if !remove {
            found.push(AbandonedWork {
                root: label,
                removed: false,
                kept: None,
            });
            continue;
        }
        let outcome = Candidate::discover(&dir).and_then(|candidate| {
            Work {
                dir: dir.clone(),
                candidate,
                _lock: lock,
            }
            .teardown()
        });
        found.push(match outcome {
            Ok(()) => AbandonedWork {
                root: label,
                removed: true,
                kept: None,
            },
            Err(failure) => kept(failure.code),
        });
    }
    Ok(found)
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

/// A published base, whether its work root was removed, and abandoned roots recovered first.
#[derive(Debug, Serialize)]
pub struct Built {
    pub receipt: Receipt,
    pub work_removed: bool,
    pub recovered_work: Vec<AbandonedWork>,
}

/// A recorded verification and abandoned roots recovered first.
#[derive(Debug, Serialize)]
pub struct Verified {
    #[serde(flatten)]
    pub verification: Verification,
    pub recovered_work: Vec<AbandonedWork>,
}

/// The store's bases and any work roots abandoned by interrupted builds or verifications.
#[derive(Debug, Serialize)]
pub struct StoreStatus {
    pub bases: Vec<Entry>,
    pub abandoned_work: Vec<AbandonedWork>,
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
    prepared_store::open(store)?;
    let recovered_work = abandoned_work(store, true)?;
    let work = Work::create(candidate, store)?;
    let outcome = seed(&work.candidate, store, profile, &base_id);
    let (receipt, work_removed) = work.finish(outcome)?;
    Ok(Built {
        receipt,
        work_removed,
        recovered_work,
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
) -> Result<Verified, CandidateError> {
    let base = prepared_base::open_published(store, base_id)?;
    let profile = profile_for(&base.receipt.pins)?;
    base.bind(&current_pins(candidate, profile)?)?;
    let recovered_work = abandoned_work(store, true)?;
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
    Ok(Verified {
        verification,
        recovered_work,
    })
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
) -> Result<StoreStatus, CandidateError> {
    Ok(StoreStatus {
        bases: prepared_store::entries(store, &current_pins(candidate, profile)?)?,
        abandoned_work: abandoned_work(store, false)?,
    })
}

/// Remove one base and its verification under the exclusive store lock.
pub fn remove_prepared_base(store: &Path, base_id: &str) -> Result<(), CandidateError> {
    let exclusive = StoreLock::exclusive(store)?;
    prepared_store::remove(store, &exclusive, base_id)
}

#[cfg(all(test, target_os = "macos"))]
mod tests;
