//! Recovery of a start interrupted before the provider process identity was recorded.
//!
//! `up` records each provider effect before or after it, but a crash can land in windows where
//! the durable receipt names no provider process. Each start clears the previous provider's
//! (already proven dead) identity before `booting`, so these windows cover every start, not
//! only the first:
//! - **`creating`, machine not recorded as created:** `machine create` may or may not have
//!   completed. Nothing was started, so no disks exist. Recovery deletes this pool's own machine
//!   record (proven by the pool-private provider database holding exactly `owner.machine`) and
//!   returns the pool to `initializing`, so the next `up` creates it again, including any
//!   prepared-base activation.
//! - **`creating` after the machine was recorded, or `booting`:** `machine start` may have
//!   launched the provider before `up` recorded it. If the provider never created the machine's
//!   disks, nothing was launched and the pool returns to `stopped-before-engine`. If the
//!   provider's own PID record remains, recovery verifies the executable, start time and user and
//!   stops it if it is alive. Otherwise the provider has exited, which removes that record. Either
//!   way the unclean stop is recorded only after the machine's VM lock, disk handles and sockets
//!   are proven released.
//!
//! A provider command orphaned by the interrupted `up` could still be acting on the pool, so
//! every path first requires that no process executes this candidate's provider binary; the
//! pool lock keeps a new one from starting meanwhile. Recovery never adopts disks: a start that
//! never adopted them leaves them unadopted, so the next boot's template, size and format checks
//! decide. One exception (HACK-2376): when the templates that start cloned from fail
//! verification after it (for example, a start cut off while SmolVM expanded them), the
//! unadopted disks and the owned failed templates are renamed into an
//! `untrusted-first-boot-<n>` directory and the pool returns to `stopped-before-engine`, so the
//! next start expands and clones them again from the verified compressed templates. Everything else without a recorded process still refuses for manual inspection.
//! Nothing unowned is adopted, stopped or removed.
use super::super::state::io;
use super::super::{
    config_audit,
    disk_template::{self, Stage},
    identity, prepared_start, state,
};
use super::{
    Owner, STOP_SCAN_WAIT, SmolvmCli, VmBackend, binary, finish_absent, lock_disks_closed, phase,
    recorded_process, sockets_absent, stop_verified_provider, verify_templates,
};
use crate::{Candidate, CandidateError};
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

/// Recovery cannot prove what an interrupted start left; the literal reason names the
/// condition, so the refusal says what to inspect. Nothing is adopted or removed. A macro so
/// the whole message is one static string: only fixed messages cross to the CLI.
macro_rules! unrecoverable {
    ($reason:literal) => {
        crate::CandidateError::new(
            "recovery_required",
            concat!(
                "No retained process identity: ",
                $reason,
                ". Manual inspection required; no state was adopted or removed."
            ),
        )
    };
}

/// Recover `owner`, whose receipt records no provider process. Caller holds the pool lock.
pub(super) fn recover(
    candidate: &Candidate,
    owner: &mut Owner,
    lock: &state::Lock,
) -> Result<(), CandidateError> {
    match (owner.phase.as_str(), owner.created) {
        ("creating", false) => recover_create(candidate, owner),
        // `created` is saved before the start's admission, so `creating` may already hold it.
        ("creating" | "booting", true) => recover_start(candidate, owner, lock),
        // What recovery itself leaves when nothing was launched or the unadopted disks were set
        // aside: nothing ran, so repeating recovery changes nothing but a completed intent.
        // A left-over intent there is one whose owner transition committed.
        ("stopped-before-engine", _) => {
            if SetAside::load(candidate)?.is_some() {
                SetAside::remove_completed(candidate)?;
            }
            Ok(())
        }
        // Already stopped with no provider recorded, as a failed boot's recovery or a refused
        // start leaves it: the stopped phases retained startup and `up` accept. Nothing ran
        // that recovery could stop, so repeating recovery changes nothing.
        ("stopped" | "recovered-unclean" | "stopped-after-engine-failure", _) => {
            if SetAside::load(candidate)?.is_some() {
                // Only `stopped-before-engine` commits a set-aside; an intent here is not one
                // this recovery wrote.
                return Err(unrecoverable!(
                    "a set-aside intent remains beside a pool that never set its disks aside"
                ));
            }
            Ok(())
        }
        _ => Err(unrecoverable!(
            "the receipt is in a phase no interrupted start leaves, with no provider recorded"
        )),
    }
}

/// Refuse while any process executes this candidate's provider, such as a command orphaned by
/// the interrupted `up`.
fn provider_idle(candidate: &Candidate) -> Result<(), CandidateError> {
    if identity::executable_running(&binary(candidate))? {
        return Err(CandidateError::new(
            "stop_uncertain",
            "A provider process for this candidate is still running; retry after it exits. Nothing was changed.",
        ));
    }
    Ok(())
}

/// Whether each named file in `directory` is present; anything but absence or presence refuses.
fn present<const N: usize>(
    directory: &std::path::Path,
    names: [&str; N],
) -> Result<[bool; N], CandidateError> {
    let mut found = [false; N];
    for (slot, name) in found.iter_mut().zip(names) {
        *slot = match fs::symlink_metadata(directory.join(name)) {
            Ok(_) => true,
            Err(error) if error.kind() == ErrorKind::NotFound => false,
            Err(_) => return Err(unrecoverable!("a provider file could not be inspected")),
        };
    }
    Ok(found)
}

fn recover_create(candidate: &Candidate, owner: &mut Owner) -> Result<(), CandidateError> {
    if present(
        &owner.real_data_dir(candidate)?,
        ["storage.raw", "overlay.raw"],
    )? != [false; 2]
    {
        return Err(unrecoverable!("an interrupted create already has disks"));
    }
    provider_idle(candidate)?;
    if config_audit::machine_recorded(candidate, owner)? {
        SmolvmCli::new(candidate, owner).delete_forced()?;
        if config_audit::machine_recorded(candidate, owner)? {
            return Err(unrecoverable!(
                "the provider still records this machine after deleting it"
            ));
        }
    }
    owner.phase = "initializing".into();
    owner.save(candidate)
}

fn recover_start(
    candidate: &Candidate,
    owner: &mut Owner,
    lock: &state::Lock,
) -> Result<(), CandidateError> {
    // The provider creates the machine's data directory and disks when it launches it.
    let directory = owner.real_data_dir(candidate)?;
    let launched = match fs::symlink_metadata(&directory) {
        Ok(_) => present(&directory, ["storage.raw", "overlay.raw"])?,
        Err(error) if error.kind() == ErrorKind::NotFound => [false; 2],
        Err(_) => {
            return Err(unrecoverable!(
                "the machine data directory could not be inspected"
            ));
        }
    };
    let adopted = owner.storage.is_some() || owner.overlay.is_some();
    if let Some(intent) = SetAside::load(candidate)? {
        // A set-aside began and did not finish: resume it. It was decided under the same
        // proofs, which are repeated below before any further move.
        let templates = prepared_start::stock_templates(candidate, owner, lock)?;
        let (false, Some(templates)) = (adopted, templates) else {
            return Err(unrecoverable!(
                "a set-aside is in progress but the disks were adopted or come from a prepared base"
            ));
        };
        provider_idle(candidate)?;
        return set_aside(candidate, owner, &templates, &intent.label);
    }
    if launched == [false; 2] && !adopted {
        // Nothing was launched, so nothing can be running once no provider command remains.
        provider_idle(candidate)?;
        owner.phase = "stopped-before-engine".into();
        return owner.save(candidate);
    }
    if launched != [true; 2] {
        return Err(unrecoverable!("only one of the two machine disks exists"));
    }
    if present(&directory, ["agent.pid"])? == [true] {
        let process = recorded_process(candidate, owner)
            .map_err(|_| unrecoverable!("the provider's PID record is unreadable or incomplete"))?;
        if !identity::provider_gone(&process)? {
            // SAFETY: geteuid has no preconditions and cannot fail.
            identity::verify(
                &process,
                &identity::observe(process.pid)?,
                &binary(candidate),
                unsafe { libc::geteuid() },
            )?;
            stop_verified_provider(&process, &binary(candidate))?;
        }
        // The record may be stale (a previous boot's) while an orphaned start is still running.
        provider_idle(candidate)?;
        let Some(templates) = untrusted_first_start(candidate, owner, lock)? else {
            owner.process = Some(process);
            owner.save(candidate)?;
            return finish_absent(candidate, owner, "recovered-unclean", false);
        };
        // The process is not recorded here: with a recorded process the next recovery would
        // take the stopped path, which adopts these disks without checking their templates.
        return set_aside(candidate, owner, &templates, &SetAside::new_label()?);
    }
    // The provider launched and exited, removing its PID record.
    provider_idle(candidate)?;
    match untrusted_first_start(candidate, owner, lock)? {
        None => finish_absent(candidate, owner, "recovered-unclean", false),
        Some(templates) => set_aside(candidate, owner, &templates, &SetAside::new_label()?),
    }
}

/// Recovery of a pool whose receipt records a provider process that is proven dead, before
/// the stopped path identifies and adopts its disks (`lifecycle::recover`). When neither disk
/// was adopted and the templates its first start cloned from do not verify, or a set-aside is
/// in progress, the disks are set aside as in [`recover_start`] and this returns `true`.
/// Otherwise it changes nothing and returns `false`. This covers a fresh boot that refused in
/// `finish_boot` (`failed-boot-stopped`), whose cleanup keeps the process recorded.
pub(super) fn set_aside_recorded(
    candidate: &Candidate,
    owner: &mut Owner,
    lock: &state::Lock,
) -> Result<bool, CandidateError> {
    if owner.storage.is_some() && owner.overlay.is_some() {
        return Ok(false);
    }
    if let Some(intent) = SetAside::load(candidate)? {
        let templates = prepared_start::stock_templates(candidate, owner, lock)?;
        let (false, false, Some(templates)) =
            (owner.storage.is_some(), owner.overlay.is_some(), templates)
        else {
            return Err(unrecoverable!(
                "a set-aside is in progress but the disks were adopted or come from a prepared base"
            ));
        };
        provider_idle(candidate)?;
        set_aside(candidate, owner, &templates, &intent.label)?;
        return Ok(true);
    }
    let Some(templates) = untrusted_first_start(candidate, owner, lock)? else {
        return Ok(false);
    };
    provider_idle(candidate)?;
    set_aside(candidate, owner, &templates, &SetAside::new_label()?)?;
    Ok(true)
}

/// At the start of `up`, first under the pool lock and before admission can change the
/// phase: a set-aside intent left by recovery must not survive
/// into a boot, whose new disks a later recovery would otherwise try to move into the old
/// set-aside directory. On `stopped-before-engine` the set-aside completed (the owner
/// transition commits it), so the intent is removed. In any other phase it may still be in
/// progress, so the boot refuses until `runtime recover` finishes it. Without an intent this
/// changes nothing.
pub(super) fn before_boot(candidate: &Candidate, owner: &Owner) -> Result<(), CandidateError> {
    if SetAside::load(candidate)?.is_none() {
        return Ok(());
    }
    if owner.phase == "stopped-before-engine" {
        return SetAside::remove_completed(candidate);
    }
    Err(CandidateError::new(
        "recovery_required",
        "A set-aside of a failed first boot's disks is not finished; run runtime recover --json before starting. Nothing was started.",
    ))
}

/// The durable intent of a set-aside in progress, beside the owner record. Written once the
/// proofs hold and before the first move, and removed only after the owner records
/// `stopped-before-engine`, so a set-aside interrupted at any point resumes (or, once the owner
/// transition committed, is cleared) instead of leaving a pool with one disk, which recovery
/// cannot tell from lost data.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SetAside {
    version: u32,
    label: String,
}

const SET_ASIDE: &str = "untrusted-first-boot.json";
const SET_ASIDE_PREFIX: &str = "untrusted-first-boot-";

impl SetAside {
    fn path(candidate: &Candidate) -> std::path::PathBuf {
        super::root(candidate).join(SET_ASIDE)
    }

    fn new_label() -> Result<String, CandidateError> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| unrecoverable!("the system clock is before 1970"))?
            .as_nanos();
        Ok(format!("{SET_ASIDE_PREFIX}{nanos}"))
    }

    /// Remove the pending file of an intent write that never reached its rename (an
    /// interruption, or a write or sync error). No move happens before the intent is published,
    /// so that file guards nothing; left in place, it would refuse every later write. Only a
    /// private regular file of ours with one link is removed; anything else refuses.
    fn discard_unpublished(candidate: &Candidate) -> Result<(), CandidateError> {
        use std::os::unix::fs::MetadataExt;
        let pending = Self::path(candidate).with_extension("pending");
        let metadata = match fs::symlink_metadata(&pending) {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(_) => {
                return Err(unrecoverable!(
                    "an unpublished set-aside intent could not be inspected"
                ));
            }
            Ok(metadata) => metadata,
        };
        // SAFETY: geteuid has no preconditions and cannot fail.
        let ours = metadata.file_type().is_file()
            && metadata.nlink() == 1
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0;
        if !ours {
            return Err(unrecoverable!(
                "an unpublished set-aside intent is not a private file of this user"
            ));
        }
        fs::remove_file(&pending).map_err(io)
    }

    /// Remove the intent of a set-aside whose owner transition has committed.
    fn remove_completed(candidate: &Candidate) -> Result<(), CandidateError> {
        match fs::remove_file(Self::path(candidate)) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(io(error)),
        }
        fs::File::open(super::root(candidate))
            .and_then(|directory| directory.sync_all())
            .map_err(io)
    }

    fn load(candidate: &Candidate) -> Result<Option<Self>, CandidateError> {
        match fs::symlink_metadata(Self::path(candidate)) {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(_) => {
                return Err(unrecoverable!(
                    "the set-aside intent could not be inspected"
                ));
            }
            Ok(_) => {}
        }
        let intent: Self = state::read(&Self::path(candidate))
            .map_err(|_| unrecoverable!("the set-aside intent is unreadable"))?;
        let valid = intent.version == 1
            && intent
                .label
                .strip_prefix(SET_ASIDE_PREFIX)
                .is_some_and(|n| {
                    !n.is_empty() && n.len() <= 40 && n.bytes().all(|b| b.is_ascii_digit())
                });
        if !valid {
            return Err(unrecoverable!("the set-aside intent is malformed"));
        }
        Ok(Some(intent))
    }
}

/// Verify the templates the interrupted first start cloned from (`Stage::AfterFirstStart`).
/// `Ok(None)`: verified. `Ok(Some(dir))`: refused, but the disks were never adopted and came
/// from the stock templates in `dir`, so recovery may set them aside. Every other refusal,
/// including any adopted disk or a prepared-base activation, is returned unchanged.
fn untrusted_first_start(
    candidate: &Candidate,
    owner: &Owner,
    lock: &state::Lock,
) -> Result<Option<std::path::PathBuf>, CandidateError> {
    let Err(error) = verify_templates(candidate, owner, lock, Stage::AfterFirstStart) else {
        return Ok(None);
    };
    if error.code != "disk_template_untrusted" || owner.storage.is_some() || owner.overlay.is_some()
    {
        return Err(error);
    }
    match prepared_start::stock_templates(candidate, owner, lock)? {
        Some(directory) => Ok(Some(directory)),
        None => Err(error),
    }
}

/// Set aside the unadopted disks of a first start whose templates did not verify, and the
/// owned templates that failed, then return the pool to `stopped-before-engine` (HACK-2376).
///
/// Runs only after the provider was proven stopped and idle, under the VM lock with the disk
/// handles proven closed and the owned sockets absent, as an unclean stop does. Those disks were
/// never adopted, so they never held project data (graph start needs `running`). Nothing is
/// deleted: each file is renamed into a `label` directory beside it, for inspection. The
/// verified compressed templates stay, so the next start expands the templates again and
/// clones new disks, and verifies them before adoption as every first start does. A refusal
/// before the intent is written changes nothing; after it, recovery resumes (`SetAside`).
fn set_aside(
    candidate: &Candidate,
    owner: &mut Owner,
    templates: &Path,
    label: &str,
) -> Result<(), CandidateError> {
    let failed = disk_template::owned_unverified(templates)?;
    let data = owner.real_data_dir(candidate)?;
    let disks = ["storage.raw", "overlay.raw"];
    // Each disk is at its original path or, after an interrupted set-aside, already moved.
    let mut locations = Vec::new();
    let mut remaining = Vec::new();
    for name in disks {
        match present(&data, [name])? {
            [true] => {
                locations.push(data.join(name));
                remaining.push(name);
            }
            _ if present(&data.join(label), [name])? == [true] => {
                locations.push(data.join(label).join(name));
            }
            _ => {
                return Err(unrecoverable!(
                    "a machine disk is missing from both its place and the set-aside directory"
                ));
            }
        }
    }
    // Unadopted disks have no recorded identity for `verify_disks` to check, so check here
    // that each is a regular file of ours with one link before anything moves.
    for location in &locations {
        owned_file(location)?;
    }
    let vm_lock = lock_disks_closed(candidate, owner, &locations, STOP_SCAN_WAIT)?;
    sockets_absent(owner)?;
    if SetAside::load(candidate)?.is_none() {
        SetAside::discard_unpublished(candidate)?;
        state::write(
            &SetAside::path(candidate),
            &SetAside {
                version: 1,
                label: label.to_owned(),
            },
        )?;
    }
    move_into(&data, label, &remaining)?;
    move_into(templates, label, &failed)?;
    // A replay may have nothing left to move: make the moves of every attempt durable anyway.
    for directory in [&data, templates] {
        sync_moved(directory, label)?;
    }
    #[cfg(target_os = "macos")]
    super::super::interactive_session::after_boot_stopped(candidate, owner);
    // The owner transition commits the set-aside; the intent is removed only after it. An
    // interruption between the two leaves `stopped-before-engine` with the intent, which
    // `recover` then removes as complete.
    owner.process = None;
    phase(candidate, owner, "stopped-before-engine")?;
    SetAside::remove_completed(candidate)?;
    drop(vm_lock);
    Ok(())
}

/// Refuse unless `path` is a regular file owned by this user with one link.
fn owned_file(path: &Path) -> Result<(), CandidateError> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| unrecoverable!("a machine disk could not be inspected"))?;
    // SAFETY: geteuid has no preconditions and cannot fail.
    if !metadata.file_type().is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(CandidateError::new(
            "foreign_state",
            "An unadopted provider disk is not a regular file of this user with one link; nothing was moved.",
        ));
    }
    Ok(())
}

/// Rename each of `names` from `directory` into the private `directory/label`. Same file
/// system, so each rename is atomic; a name already present there refuses rather than
/// replacing it.
fn move_into(directory: &Path, label: &str, names: &[&str]) -> Result<(), CandidateError> {
    if names.is_empty() {
        return Ok(());
    }
    let aside = directory.join(label);
    state::private_directory(&aside)?;
    for name in names {
        if present(&aside, [*name])? == [true] {
            return Err(unrecoverable!(
                "the set-aside directory already holds a file of that name"
            ));
        }
        fs::rename(directory.join(name), aside.join(name)).map_err(io)?;
    }
    Ok(())
}

/// Sync `directory` and, when present, `directory/label`.
fn sync_moved(directory: &Path, label: &str) -> Result<(), CandidateError> {
    let aside = directory.join(label);
    if present(directory, [label])? == [true] {
        fs::File::open(&aside).map_err(io)?.sync_all().map_err(io)?;
    }
    fs::File::open(directory)
        .map_err(io)?
        .sync_all()
        .map_err(io)
}

#[cfg(test)]
mod refusal_tests {
    #[test]
    fn every_unproven_condition_is_one_fixed_message_the_cli_shows() {
        let error: crate::CandidateError =
            unrecoverable!("only one of the two machine disks exists");
        assert_eq!(error.code, "recovery_required");
        // Only a fixed (static) message crosses to the CLI (`nativeFailureDetail`).
        assert!(error.message_fixed);
        assert_eq!(
            error.message,
            "No retained process identity: only one of the two machine disks exists. Manual inspection required; no state was adopted or removed."
        );
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::super::root;
    use super::*;

    /// A pool whose receipt names no process, in `phase`, with no provider binary installed.
    struct Pool {
        candidate: Candidate,
        checkout: std::path::PathBuf,
    }

    impl Pool {
        fn new(label: &str) -> Self {
            let checkout = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "hack-interrupted-{label}-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                crate::next_test_scratch()
            ));
            fs::create_dir(&checkout).unwrap();
            let candidate = Candidate::discover(&checkout).unwrap();
            state::private_directory(&root(&candidate)).unwrap();
            Self {
                candidate,
                checkout,
            }
        }

        fn owner(&self, phase: &str, created: bool, adopted: bool) -> Owner {
            let disk = serde_json::json!({"device": 1, "inode": 2, "bytes": 3, "uuid": "fixture"});
            let disk = if adopted {
                disk
            } else {
                serde_json::Value::Null
            };
            serde_json::from_value(serde_json::json!({
                "version": 1, "checkout": "/fixture", "token": "fixture", "machine": "fixture",
                "short_home": "/fixture", "created": created, "phase": phase,
                "process": null, "storage": disk, "overlay": disk, "guest_boot_id": null,
                "daemon_pid": null, "daemon_start": null, "rootfs_digest": null
            }))
            .unwrap()
        }

        fn disks(&self, owner: &Owner, names: &[&str]) {
            let directory = owner.real_data_dir(&self.candidate).unwrap();
            state::private_directory(&directory).unwrap();
            for name in names {
                fs::write(directory.join(name), b"disk").unwrap();
            }
        }

        fn recover(&self, owner: &mut Owner) -> Result<(), CandidateError> {
            let lock = state::Lock::acquire(&root(&self.candidate)).unwrap();
            recover(&self.candidate, owner, &lock)
        }
    }

    impl Drop for Pool {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.checkout);
        }
    }

    #[test]
    fn a_start_that_never_launched_returns_to_stopped_before_engine() {
        // Also a start interrupted after `created` was saved but before `booting`.
        for (index, phase) in ["booting", "creating"].into_iter().enumerate() {
            let pool = Pool::new(&format!("never-launched-{index}"));
            let mut owner = pool.owner(phase, true, false);
            pool.recover(&mut owner).unwrap();
            assert_eq!(owner.phase, "stopped-before-engine", "{phase}");
            let saved: serde_json::Value = serde_json::from_slice(
                &fs::read(root(&pool.candidate).join("owner.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(saved["phase"], "stopped-before-engine", "{phase}");
        }
    }

    #[test]
    fn a_running_provider_refuses_every_path_even_with_a_stale_pid_record() {
        let cases: [(&str, bool, &[&str], Option<&str>); 5] = [
            ("creating", false, &[], None),
            ("creating", true, &[], None),
            ("booting", true, &[], None),
            ("booting", true, &["storage.raw", "overlay.raw"], None),
            // A previous boot's record naming a dead process, while an orphaned start may run.
            (
                "booting",
                true,
                &["storage.raw", "overlay.raw"],
                Some("99999\n1\n"),
            ),
        ];
        for (index, (phase, created, disks, pid_record)) in cases.into_iter().enumerate() {
            let pool = Pool::new(&format!("provider-running-{index}"));
            let mut owner = pool.owner(phase, created, false);
            pool.disks(&owner, disks);
            if let Some(record) = pid_record {
                let directory = owner.real_data_dir(&pool.candidate).unwrap();
                fs::write(directory.join("agent.pid"), record).unwrap();
            }
            // Run an owned executable at this candidate's exact provider path.
            let provider = binary(&pool.candidate);
            fs::create_dir_all(provider.parent().unwrap()).unwrap();
            crate::provider::test_executable::sleeping_executable(&provider);
            let mut running = std::process::Command::new(&provider)
                .arg("30")
                .spawn()
                .unwrap();
            let outcome = pool.recover(&mut owner);
            running.kill().unwrap();
            running.wait().unwrap();
            assert_eq!(outcome.unwrap_err().code, "stop_uncertain", "case {index}");
            assert_eq!(owner.phase, phase, "case {index}");
            assert!(
                !root(&pool.candidate).join("owner.json").exists(),
                "case {index}"
            );
        }
    }

    #[test]
    fn an_unclean_stop_after_recovery_leaves_unadopted_disks_unadopted() {
        // The stop must find the disks this test just wrote released. In the shared parallel
        // test process an unrelated test's pre-exec fork (`process::clean_command`) can hold a
        // copy of such a handle until it execs, which the host-wide disk-handle scan correctly
        // reports as `stop_uncertain`. Run the fixture alone in a child test process.
        use crate::provider::test_executable::{ISOLATED_HANG_GUARD, run_isolated};
        run_isolated(
            "provider::lifecycle::interrupted::tests::unadopted_unclean_stop_child",
            ISOLATED_HANG_GUARD,
        );
    }

    #[test]
    #[ignore = "isolated release-check fixture launched by an_unclean_stop_after_recovery_leaves_unadopted_disks_unadopted"]
    fn unadopted_unclean_stop_child() {
        let pool = Pool::new("unadopted");
        let mut owner = pool.owner("booting", true, false);
        pool.disks(&owner, &["storage.raw", "overlay.raw", "vm.lock"]);
        let directory = owner.real_data_dir(&pool.candidate).unwrap();
        fs::write(directory.join("name"), "fixture\n").unwrap();
        finish_absent(&pool.candidate, &mut owner, "recovered-unclean", false).unwrap();
        assert_eq!(owner.phase, "recovered-unclean");
        assert!(owner.storage.is_none() && owner.overlay.is_none());
        // Recording identifies the disks now, which these non-ext4 fixture files fail; the next
        // boot's allocation and format checks are what should decide instead.
        // The error is the identification itself (a 4-byte fixture has no superblock to read),
        // not an earlier release check such as a slow disk-handle scan (HACK-1457).
        let mut recording = pool.owner("booting", true, false);
        let error =
            finish_absent(&pool.candidate, &mut recording, "recovered-unclean", true).unwrap_err();
        assert_eq!(
            error.code, "provider_state",
            "E_TEST_RECORDING_REFUSED_EARLY"
        );
        assert!(
            recording.storage.is_none(),
            "E_TEST_RECORDING_REFUSED_EARLY"
        );
    }

    #[test]
    fn a_first_start_with_unverified_templates_sets_its_unadopted_disks_aside() {
        // Same isolation reason as the unclean-stop fixture: the host-wide disk-handle scan.
        use crate::provider::test_executable::{ISOLATED_HANG_GUARD, run_isolated};
        run_isolated(
            "provider::lifecycle::interrupted::tests::untrusted_first_start_child",
            ISOLATED_HANG_GUARD,
        );
    }

    /// Write a sparse file of the pinned template's size whose content differs from the pin.
    fn wrong_template(directory: &std::path::Path, name: &str, len: u64) {
        use std::os::unix::fs::{FileExt, PermissionsExt};
        state::private_directory(directory).unwrap();
        let file = fs::File::create(directory.join(name)).unwrap();
        file.write_all_at(b"partial", 0).unwrap();
        file.set_len(len).unwrap();
        fs::set_permissions(directory.join(name), fs::Permissions::from_mode(0o644)).unwrap();
    }

    #[test]
    #[ignore = "isolated release-check fixture launched by a_first_start_with_unverified_templates_sets_its_unadopted_disks_aside"]
    fn untrusted_first_start_child() {
        let pinned = crate::provider::disk_template::PINNED;
        // (a) the expansion never finished, so no template is present;
        // (b) a wrong overlay template is present beside a missing storage one.
        for (index, wrong) in [false, true].into_iter().enumerate() {
            let pool = Pool::new(&format!("untrusted-{index}"));
            let mut owner = pool.owner("booting", true, false);
            pool.disks(&owner, &["storage.raw", "overlay.raw", "vm.lock"]);
            let data = owner.real_data_dir(&pool.candidate).unwrap();
            fs::write(data.join("name"), "fixture\n").unwrap();
            let templates = root(&pool.candidate).join("home/.smolvm");
            state::private_directory(&root(&pool.candidate).join("home")).unwrap();
            state::private_directory(&templates).unwrap();
            fs::write(
                templates.join("overlay-template.ext4.zst"),
                b"verified input",
            )
            .unwrap();
            if wrong {
                wrong_template(&templates, pinned[1].name, pinned[1].logical_len);
            }
            pool.recover(&mut owner).unwrap();
            assert_eq!(owner.phase, "stopped-before-engine", "case {index}");
            assert!(
                owner.process.is_none() && owner.storage.is_none(),
                "case {index}"
            );
            let saved: serde_json::Value = serde_json::from_slice(
                &fs::read(root(&pool.candidate).join("owner.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(saved["phase"], "stopped-before-engine", "case {index}");
            // Nothing deleted: the disks and the wrong template moved aside, the input stayed.
            let aside = |directory: &std::path::Path| {
                let mut found = fs::read_dir(directory)
                    .unwrap()
                    .map(|entry| entry.unwrap().path())
                    .filter(|path| {
                        path.file_name()
                            .unwrap()
                            .to_string_lossy()
                            .starts_with("untrusted-first-boot-")
                    })
                    .collect::<Vec<_>>();
                found.sort();
                found
            };
            let disks = aside(&data);
            assert_eq!(disks.len(), 1, "case {index}");
            assert!(disks[0].join("storage.raw").exists() && disks[0].join("overlay.raw").exists());
            assert!(!data.join("storage.raw").exists() && !data.join("overlay.raw").exists());
            assert!(templates.join("overlay-template.ext4.zst").exists());
            let moved = aside(&templates);
            if wrong {
                assert!(moved[0].join(pinned[1].name).exists(), "case {index}");
                assert!(!templates.join(pinned[1].name).exists(), "case {index}");
            } else {
                assert!(moved.is_empty(), "case {index}");
            }
            assert!(
                !root(&pool.candidate).join(SET_ASIDE).exists(),
                "case {index}"
            );
            // The returned state is the never-launched one: a second recovery changes nothing.
            pool.recover(&mut owner).unwrap();
            assert_eq!(owner.phase, "stopped-before-engine", "case {index}");
            assert_eq!(aside(&data).len(), 1, "case {index}");
        }

        // An intent write interrupted before its rename leaves only its pending file, and no
        // disk has moved: recovery discards that file and completes.
        {
            use std::os::unix::fs::PermissionsExt;
            let pool = Pool::new("untrusted-pending");
            let mut owner = pool.owner("booting", true, false);
            pool.disks(&owner, &["storage.raw", "overlay.raw", "vm.lock"]);
            let data = owner.real_data_dir(&pool.candidate).unwrap();
            fs::write(data.join("name"), "fixture\n").unwrap();
            state::private_directory(&root(&pool.candidate).join("home/.smolvm")).unwrap();
            let pending = root(&pool.candidate).join("untrusted-first-boot.pending");
            fs::write(&pending, b"{\"version\":1").unwrap();
            fs::set_permissions(&pending, fs::Permissions::from_mode(0o600)).unwrap();
            pool.recover(&mut owner).unwrap();
            assert_eq!(owner.phase, "stopped-before-engine");
            assert!(!pending.exists() && !root(&pool.candidate).join(SET_ASIDE).exists());
            assert!(!data.join("storage.raw").exists());
        }

        // A set-aside interrupted after its first move resumes from its durable intent.
        let pool = Pool::new("untrusted-resume");
        let mut owner = pool.owner("booting", true, false);
        pool.disks(&owner, &["storage.raw", "overlay.raw", "vm.lock"]);
        let data = owner.real_data_dir(&pool.candidate).unwrap();
        fs::write(data.join("name"), "fixture\n").unwrap();
        let templates = root(&pool.candidate).join("home/.smolvm");
        state::private_directory(&templates).unwrap();
        let label = "untrusted-first-boot-1";
        state::write(
            &root(&pool.candidate).join(SET_ASIDE),
            &SetAside {
                version: 1,
                label: label.into(),
            },
        )
        .unwrap();
        state::private_directory(&data.join(label)).unwrap();
        fs::rename(
            data.join("storage.raw"),
            data.join(label).join("storage.raw"),
        )
        .unwrap();
        pool.recover(&mut owner).unwrap();
        assert_eq!(owner.phase, "stopped-before-engine");
        assert!(data.join(label).join("storage.raw").exists());
        assert!(data.join(label).join("overlay.raw").exists());
        assert!(!data.join("overlay.raw").exists());
        assert!(!root(&pool.candidate).join(SET_ASIDE).exists());
    }

    #[test]
    fn unverified_templates_never_move_adopted_or_foreign_files() {
        let pinned = crate::provider::disk_template::PINNED;
        // Adopted disks are pinned by identity: a template mismatch there is not set aside.
        // (Unreachable through `verify_templates`, which skips adopted pools, so this
        // checks the guard directly.)
        let pool = Pool::new("adopted-untrusted");
        let owner = pool.owner("booting", true, true);
        let lock = state::Lock::acquire(&root(&pool.candidate)).unwrap();
        assert_eq!(
            untrusted_first_start(&pool.candidate, &owner, &lock).unwrap(),
            None
        );
        drop(lock);
        // A template that may not be ours (hard-linked) refuses before anything moves.
        let pool = Pool::new("foreign-template");
        let mut owner = pool.owner("booting", true, false);
        pool.disks(&owner, &["storage.raw", "overlay.raw", "vm.lock"]);
        let templates = root(&pool.candidate).join("home/.smolvm");
        state::private_directory(&root(&pool.candidate).join("home")).unwrap();
        wrong_template(&templates, pinned[0].name, pinned[0].logical_len);
        fs::hard_link(
            templates.join(pinned[0].name),
            templates.join("second-link"),
        )
        .unwrap();
        let error = pool.recover(&mut owner).unwrap_err();
        assert_eq!(error.code, "disk_template_untrusted");
        assert!(
            error.message.contains("is hard-linked"),
            "{}",
            error.message
        );
        assert_eq!(owner.phase, "booting");
        let data = owner.real_data_dir(&pool.candidate).unwrap();
        assert!(data.join("storage.raw").exists() && templates.join(pinned[0].name).exists());
        assert!(!root(&pool.candidate).join("owner.json").exists());
        // With the provider's PID record left behind, that refusal still records no process:
        // a recorded one would route the next recovery to the stopped path, which adopts the
        // disks without checking their templates.
        fs::write(data.join("agent.pid"), "99999\n1\n").unwrap();
        let error = pool.recover(&mut owner).unwrap_err();
        assert_eq!(error.code, "disk_template_untrusted");
        assert!(owner.process.is_none());
        assert!(!root(&pool.candidate).join("owner.json").exists());
        assert!(!root(&pool.candidate).join(SET_ASIDE).exists());

        // A disk path that is not a regular file of ours (here a symlink) refuses first.
        let pool = Pool::new("foreign-disk");
        let mut owner = pool.owner("booting", true, false);
        pool.disks(&owner, &["overlay.raw", "vm.lock", "elsewhere"]);
        let data = owner.real_data_dir(&pool.candidate).unwrap();
        std::os::unix::fs::symlink(data.join("elsewhere"), data.join("storage.raw")).unwrap();
        state::private_directory(&root(&pool.candidate).join("home/.smolvm")).unwrap();
        let error = pool.recover(&mut owner).unwrap_err();
        assert_eq!(error.code, "foreign_state");
        assert!(fs::symlink_metadata(data.join("storage.raw")).is_ok());
        assert!(data.join("overlay.raw").exists());
        assert!(!root(&pool.candidate).join(SET_ASIDE).exists());

        // Before a boot, a completed intent is removed and one still in progress refuses.
        {
            let pool = Pool::new("before-boot");
            let intent = || {
                state::write(
                    &root(&pool.candidate).join(SET_ASIDE),
                    &SetAside {
                        version: 1,
                        label: "untrusted-first-boot-1".into(),
                    },
                )
                .unwrap()
            };
            let stopped = pool.owner("stopped-before-engine", true, false);
            before_boot(&pool.candidate, &stopped).unwrap();
            intent();
            before_boot(&pool.candidate, &stopped).unwrap();
            assert!(!root(&pool.candidate).join(SET_ASIDE).exists());
            intent();
            let failed = pool.owner("failed-boot-stopped", true, false);
            assert_eq!(
                before_boot(&pool.candidate, &failed).unwrap_err().code,
                "recovery_required"
            );
            assert!(root(&pool.candidate).join(SET_ASIDE).exists());
        }

        // Interrupted after the owner committed `stopped-before-engine` but before the intent
        // was removed: recovery clears the completed intent and changes nothing else.
        let pool = Pool::new("committed-intent");
        let mut owner = pool.owner("stopped-before-engine", true, false);
        state::write(
            &root(&pool.candidate).join(SET_ASIDE),
            &SetAside {
                version: 1,
                label: "untrusted-first-boot-1".into(),
            },
        )
        .unwrap();
        pool.recover(&mut owner).unwrap();
        assert_eq!(owner.phase, "stopped-before-engine");
        assert!(!root(&pool.candidate).join(SET_ASIDE).exists());
    }

    #[test]
    fn a_recorded_failed_first_boot_with_unverified_templates_is_set_aside_not_adopted() {
        use crate::provider::test_executable::{ISOLATED_HANG_GUARD, run_isolated};
        run_isolated(
            "provider::lifecycle::interrupted::tests::recorded_failed_boot_child",
            ISOLATED_HANG_GUARD,
        );
    }

    #[test]
    #[ignore = "isolated release-check fixture launched by a_recorded_failed_first_boot_with_unverified_templates_is_set_aside_not_adopted"]
    fn recorded_failed_boot_child() {
        // `finish_boot` refused the templates and its cleanup kept the dead process recorded.
        let pool = Pool::new("recorded-failed-boot");
        let mut owner = pool.owner("failed-boot-stopped", true, false);
        owner.process = Some(identity::ProcessIdentity {
            pid: 99_999,
            start_micros: 1,
            uid: unsafe { libc::geteuid() },
            executable: binary(&pool.candidate),
        });
        owner.save(&pool.candidate).unwrap();
        pool.disks(&owner, &["storage.raw", "overlay.raw", "vm.lock"]);
        let data = owner.real_data_dir(&pool.candidate).unwrap();
        fs::write(data.join("name"), "fixture\n").unwrap();
        state::private_directory(&root(&pool.candidate).join("home/.smolvm")).unwrap();
        let lock = state::Lock::acquire(&root(&pool.candidate)).unwrap();
        assert!(set_aside_recorded(&pool.candidate, &mut owner, &lock).unwrap());
        assert_eq!(owner.phase, "stopped-before-engine");
        assert!(owner.process.is_none() && owner.storage.is_none() && owner.overlay.is_none());
        assert!(!data.join("storage.raw").exists() && !data.join("overlay.raw").exists());
        // Adopted disks are left to the stopped path.
        let mut adopted = pool.owner("failed-boot-stopped", true, true);
        assert!(!set_aside_recorded(&pool.candidate, &mut adopted, &lock).unwrap());
    }

    #[test]
    fn recovery_of_an_already_stopped_pool_without_a_provider_changes_nothing_twice() {
        // The failed-first-boot homes after their first recovery: `recovered-unclean`, no
        // provider recorded, nothing running (lead's real-VM run of #1001).
        for phase in [
            "recovered-unclean",
            "stopped",
            "stopped-after-engine-failure",
            "stopped-before-engine",
        ] {
            let pool = Pool::new(&format!("already-stopped-{phase}"));
            let mut owner = pool.owner(phase, true, false);
            owner.save(&pool.candidate).unwrap();
            let before = fs::read(root(&pool.candidate).join("owner.json")).unwrap();
            for _ in 0..2 {
                pool.recover(&mut owner).unwrap();
                assert_eq!(owner.phase, phase);
                assert_eq!(
                    fs::read(root(&pool.candidate).join("owner.json")).unwrap(),
                    before,
                    "{phase}"
                );
            }
        }
        // An intent beside such a pool was not written by this recovery and refuses.
        let pool = Pool::new("already-stopped-intent");
        let mut owner = pool.owner("recovered-unclean", true, false);
        state::write(
            &root(&pool.candidate).join(SET_ASIDE),
            &SetAside {
                version: 1,
                label: "untrusted-first-boot-1".into(),
            },
        )
        .unwrap();
        assert_eq!(
            pool.recover(&mut owner).unwrap_err().code,
            "recovery_required"
        );
    }

    #[test]
    fn an_interrupted_create_without_disks_or_a_record_is_initialized_again() {
        let pool = Pool::new("create");
        let mut owner = pool.owner("creating", false, false);
        pool.recover(&mut owner).unwrap();
        assert_eq!(owner.phase, "initializing");
    }

    #[test]
    fn missing_or_partial_disks_and_other_phases_refuse_without_changes() {
        let cases: [(&str, bool, bool, &[&str]); 5] = [
            // Adopted disks are gone: never recreate them from templates.
            ("booting", true, true, &[]),
            // A partial launch cannot be told apart from lost data.
            ("booting", true, false, &["storage.raw"]),
            // Disks cannot exist before the first start.
            ("creating", false, false, &["overlay.raw"]),
            ("provisioning", true, false, &[]),
            ("running", true, true, &["storage.raw", "overlay.raw"]),
        ];
        for (index, (phase, created, adopted, disks)) in cases.into_iter().enumerate() {
            let pool = Pool::new(&format!("refuse-{index}"));
            let mut owner = pool.owner(phase, created, adopted);
            pool.disks(&owner, disks);
            let error = pool.recover(&mut owner).unwrap_err();
            assert_eq!(error.code, "recovery_required", "case {index}");
            assert_eq!(owner.phase, phase, "case {index}");
            assert!(
                !root(&pool.candidate).join("owner.json").exists(),
                "case {index}"
            );
        }
    }
}
