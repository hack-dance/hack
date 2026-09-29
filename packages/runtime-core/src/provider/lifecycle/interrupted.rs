//! Recovery of a start interrupted before the provider process identity was recorded.
//!
//! `up` records each provider effect before or after it, but a crash can land in two windows
//! where the durable receipt does not yet name a process:
//! - **`creating`, never created:** `machine create` may or may not have completed. Nothing was
//!   started, so no disks exist. Recovery deletes this pool's own machine record (proven by the
//!   pool-private provider database holding exactly `owner.machine`) and returns the pool to
//!   `initializing`, so the next `up` creates it again, including any prepared-base activation.
//! - **`booting`:** `machine start` may have launched the provider before `up` recorded it. If the
//!   provider never created the machine's disks, nothing was launched and the pool returns to
//!   `stopped-before-engine`. If the provider's own PID record remains, recovery verifies the
//!   executable, start time and user, stops it if it is alive, and finishes an ordinary unclean
//!   stop. If the provider launched and has already exited, which removes that record, recovery
//!   proves the machine released its VM lock, disks and sockets before the same unclean stop.
//!
//! Without a PID record, a provider command orphaned by the interrupted `up` could still be
//! acting on the pool, so every such path first requires that no process executes this
//! candidate's provider binary; the pool lock keeps a new one from starting meanwhile. Before
//! disks launched from a prepared base are recorded, the activated templates are verified as a
//! completed first start would have. Everything else without a recorded process still refuses
//! for manual inspection. Nothing unowned is adopted, stopped or removed.
use super::super::{config_audit, disk_template::Stage, identity, state};
use super::{
    Owner, binary, finish_absent, finish_stopped, invoke, recorded_process, stop_failed_boot,
    verify_templates,
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
    match owner.phase.as_str() {
        "creating" if !owner.created => recover_create(candidate, owner),
        "booting" if owner.created => recover_start(candidate, owner, lock),
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
        verify_templates(candidate, owner, lock, Stage::AfterFirstStart)?;
        owner.process = Some(process);
        owner.save(candidate)?;
        return finish_stopped(candidate, owner, "recovered-unclean");
    }
    // The provider launched and exited, removing its PID record.
    provider_idle(candidate)?;
    verify_templates(candidate, owner, lock, Stage::AfterFirstStart)?;
    finish_absent(candidate, owner, "recovered-unclean")
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
        let pool = Pool::new("never-launched");
        let mut owner = pool.owner("booting", true, false);
        pool.recover(&mut owner).unwrap();
        assert_eq!(owner.phase, "stopped-before-engine");
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(root(&pool.candidate).join("owner.json")).unwrap())
                .unwrap();
        assert_eq!(saved["phase"], "stopped-before-engine");
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
            ("creating", true, false, &[]),
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
