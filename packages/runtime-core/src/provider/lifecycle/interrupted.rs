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
//! decide. Everything else without a recorded process still refuses for manual inspection.
//! Nothing unowned is adopted, stopped or removed.
use super::super::{config_audit, disk_template::Stage, identity, state};
use super::{
    Owner, binary, finish_absent, invoke, recorded_process, stop_failed_boot, verify_templates,
};
use crate::{Candidate, CandidateError};
use std::fs;
use std::io::ErrorKind;

fn unrecoverable() -> CandidateError {
    CandidateError::new(
        "recovery_required",
        "No retained process identity; manual inspection required. No state adopted or removed.",
    )
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
        _ => Err(unrecoverable()),
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
            Err(_) => return Err(unrecoverable()),
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
        return Err(unrecoverable());
    }
    provider_idle(candidate)?;
    if config_audit::machine_recorded(candidate, owner)? {
        invoke(
            candidate,
            owner,
            &["machine", "delete", "--name", &owner.machine, "--force"],
        )?;
        if config_audit::machine_recorded(candidate, owner)? {
            return Err(unrecoverable());
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
        Err(_) => return Err(unrecoverable()),
    };
    let adopted = owner.storage.is_some() || owner.overlay.is_some();
    if launched == [false; 2] && !adopted {
        // Nothing was launched, so nothing can be running once no provider command remains.
        provider_idle(candidate)?;
        owner.phase = "stopped-before-engine".into();
        return owner.save(candidate);
    }
    if launched != [true; 2] {
        return Err(unrecoverable());
    }
    if present(&directory, ["agent.pid"])? == [true] {
        let process = recorded_process(candidate, owner).map_err(|_| unrecoverable())?;
        if identity::alive(process.pid)? {
            // SAFETY: geteuid has no preconditions and cannot fail.
            identity::verify(
                &process,
                &identity::observe(process.pid)?,
                &binary(candidate),
                unsafe { libc::geteuid() },
            )?;
            stop_failed_boot(&process, &binary(candidate))?;
        }
        // The record may be stale (a previous boot's) while an orphaned start is still running.
        provider_idle(candidate)?;
        verify_templates(candidate, owner, lock, Stage::AfterFirstStart)?;
        owner.process = Some(process);
        owner.save(candidate)?;
        return finish_absent(candidate, owner, "recovered-unclean", false);
    }
    // The provider launched and exited, removing its PID record.
    provider_idle(candidate)?;
    verify_templates(candidate, owner, lock, Stage::AfterFirstStart)?;
    finish_absent(candidate, owner, "recovered-unclean", false)
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
                "hack-interrupted-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
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
            // Run a copied executable at this candidate's exact provider path.
            let provider = binary(&pool.candidate);
            fs::create_dir_all(provider.parent().unwrap()).unwrap();
            fs::copy("/bin/sleep", &provider).unwrap();
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
        let mut recording = pool.owner("booting", true, false);
        assert!(finish_absent(&pool.candidate, &mut recording, "recovered-unclean", true).is_err());
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
