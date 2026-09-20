//! Retained value-free evidence also reserves the slot ID after active-intent reclamation.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

#[derive(Debug, Serialize)]
pub struct RetiredExport {
    pub slot: String,
    pub path: PathBuf,
    pub sha256: String,
    pub source_absent: bool,
}
fn destination(candidate: &Candidate, slot: &str) -> Result<PathBuf, CandidateError> {
    if !valid_slot(slot) {
        return Err(error());
    }
    let parent = candidate.state_root.join("exports/environment-intents");
    crate::reject_aliased_state(&parent)?;
    if parent.exists() {
        state::check_private_directory(&parent)?;
    }
    Ok(parent.join(format!("{slot}.json")))
}
pub(super) fn reserved(candidate: &Candidate, slot: &str) -> Result<bool, CandidateError> {
    match destination(candidate, slot)?.symlink_metadata() {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(state::io(e)),
    }
}
fn present(path: &Path) -> Result<bool, CandidateError> {
    match path.symlink_metadata() {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(state::io(e)),
    }
}
fn bytes(path: &Path) -> Result<Vec<u8>, CandidateError> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(state::io)?;
    let m = file.metadata().map_err(state::io)?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
        || m.len() > 2048
    {
        return Err(error());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(2049)
        .read_to_end(&mut bytes)
        .map_err(state::io)?;
    if bytes.len() as u64 != m.len() {
        return Err(error());
    }
    Ok(bytes)
}
fn checked(
    bytes: &[u8],
    slot: &str,
    guest: &OwnedGuest<'_>,
    lease: Option<&EnvironmentLease>,
) -> Result<Intent, CandidateError> {
    let intent: Intent = serde_json::from_slice(bytes).map_err(|_| error())?;
    validate(&intent, slot)?;
    if intent.graph.is_some()
        || intent.incarnation != guest.incarnation()
        || lease.is_some_and(|l| {
            l.graph != intent.graph
                || l.service != intent.service
                || l.uid != intent.uid
                || l.gid != intent.gid
                || l.boot != intent.boot
                || l.incarnation != intent.incarnation
        })
    {
        return Err(error());
    }
    Ok(intent)
}
pub(super) fn absent(guest: &OwnedGuest<'_>, slot: &str) -> Result<(), CandidateError> {
    if guest.execute_cleanup(
        "test ! -e \"/run/$1\"\ntest ! -L \"/run/$1\"\nprintf 'retired-slot-absent\\n'",
        &[slot],
    )? != "retired-slot-absent\n"
    {
        return Err(error());
    }
    Ok(())
}
pub(super) fn verify_retired(
    candidate: &Candidate,
    guest: &OwnedGuest<'_>,
    slot: &str,
    lease: Option<&EnvironmentLease>,
) -> Result<(), CandidateError> {
    checked(&bytes(&destination(candidate, slot)?)?, slot, guest, lease)?;
    absent(guest, slot)
}

/// Export an already absent standalone slot, preserving its immutable bytes and ID reservation.
/// Live slots and graph-bound records are refused; this operation never retires live delivery.
pub fn export_retired(candidate: &Candidate, slot: &str) -> Result<RetiredExport, CandidateError> {
    let guest = OwnedGuest::connect_cleanup(candidate)?;
    let target = destination(candidate, slot)?;
    crate::reject_aliased_state(&root(candidate))?;
    let source = root(candidate).join(format!("{slot}.json"));
    let pending = source.with_extension("pending");
    if reserved(candidate, slot)? {
        if present(&source)? || present(&pending)? {
            return Err(error());
        }
    } else {
        let intent = read_mode(candidate, slot, guest.incarnation(), None, false)?;
        if intent.graph.is_some() {
            return Err(error());
        }
        absent(&guest, slot)?;
        read(candidate, slot, guest.incarnation(), None)?;
        let original = bytes(&source)?;
        checked(&original, slot, &guest, None)?;
        let parent = target.parent().expect("export parent");
        state::private_directory(parent)?;
        if fs::read_dir(parent).map_err(state::io)?.take(4096).count() >= 4096 {
            return Err(error());
        }
        fs::File::open(parent.parent().expect("exports"))
            .and_then(|f| f.sync_all())
            .map_err(state::io)?;
        fs::rename(&source, &target).map_err(state::io)?;
        for directory in [parent, source.parent().expect("active intents")] {
            fs::File::open(directory)
                .and_then(|f| f.sync_all())
                .map_err(state::io)?;
        }
        if bytes(&target)? != original {
            return Err(error());
        }
        #[cfg(test)]
        if std::env::var("HACK_LOCAL_ENV_EXPORT_FAULT").as_deref() == Ok("after-move") {
            state::write(
                &candidate
                    .state_root
                    .join("run")
                    .join(format!("retired-export-{slot}.json")),
                &serde_json::json!({"slot":slot}),
            )?;
            loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
    }
    let retained = bytes(&target)?;
    checked(&retained, slot, &guest, None)?;
    absent(&guest, slot)?;
    Ok(RetiredExport {
        slot: slot.into(),
        path: target,
        sha256: format!("{:x}", Sha256::digest(&retained)),
        source_absent: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::BTreeMap,
        os::unix::process::ExitStatusExt,
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };
    struct OwnedChild(Option<Child>);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if let Some(child) = &mut self.0 {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    #[test]
    #[ignore = "Owned subprocess helper only"]
    fn retired_export_child() {
        let candidate =
            Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap()))
                .unwrap();
        export_retired(
            &candidate,
            &std::env::var("HACK_LOCAL_EXPORT_SLOT").unwrap(),
        )
        .unwrap();
        panic!("fault helper unexpectedly completed");
    }
    #[test]
    #[ignore = "Manual owned VM and external watchdog required"]
    fn retired_export_refuses_live_delivery_and_recovers_driver_loss() -> Result<(), CandidateError>
    {
        let candidate =
            Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap()))?;
        let lease = super::super::super::environment::PendingEnvironment::new(
            "retention",
            &BTreeMap::from([("TOKEN".into(), "synthetic-standalone-retention".into())]),
            Duration::from_secs(120),
        )?
        .stage(&candidate)?;
        let slot = lease.slot.clone();
        let source = root(&candidate).join(format!("{slot}.json"));
        let original = bytes(&source)?;
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || -> Result<(), CandidateError> {
                assert!(export_retired(&candidate, &slot).is_err());
                assert_eq!(bytes(&source)?, original);
                lease.remove(&candidate)?;
                let mut child=OwnedChild(Some(Command::new(std::env::current_exe().map_err(state::io)?)
                .args(["--ignored","--exact","provider::environment_recovery::retention::tests::retired_export_child","--nocapture"])
                .env("HACK_LOCAL_EXPORT_SLOT",&slot).env("HACK_LOCAL_ENV_EXPORT_FAULT","after-move")
                .stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(state::io)?));
                let marker = candidate
                    .state_root
                    .join("run")
                    .join(format!("retired-export-{slot}.json"));
                let deadline = Instant::now() + Duration::from_secs(30);
                while !marker.exists() {
                    assert!(
                        child
                            .0
                            .as_mut()
                            .unwrap()
                            .try_wait()
                            .map_err(state::io)?
                            .is_none()
                    );
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(20));
                }
                let value: serde_json::Value = state::read(&marker)?;
                assert_eq!(value["slot"], slot);
                child.0.as_mut().unwrap().kill().map_err(state::io)?;
                assert_eq!(
                    child
                        .0
                        .as_mut()
                        .unwrap()
                        .wait()
                        .map_err(state::io)?
                        .signal(),
                    Some(libc::SIGKILL)
                );
                child.0 = None;
                assert!(!source.exists());
                assert_eq!(bytes(&destination(&candidate, &slot)?)?, original);
                let exported = export_retired(&candidate, &slot)?;
                assert!(exported.source_absent);
                assert_eq!(export_retired(&candidate, &slot)?.sha256, exported.sha256);
                assert!(record(&candidate, &lease).is_err());
                assert!(!source.exists());
                assert!(!recorded_slots(&candidate)?.contains(&slot));
                assert!(
                    !original
                        .windows(b"synthetic-standalone-retention".len())
                        .any(|w| w == b"synthetic-standalone-retention")
                );
                Ok(())
            },
        ));
        lease.remove(&candidate)?;
        outcome.unwrap()
    }
    #[test]
    #[ignore = "Explicit prior-boot standalone manifest, owned VM and watchdog required"]
    fn export_manifest_of_retired_standalone_intents() -> Result<(), CandidateError> {
        let candidate =
            Candidate::discover(Path::new(&std::env::var("HACK_LOCAL_TEST_ROOT").unwrap()))?;
        let manifest = PathBuf::from(std::env::var("HACK_LOCAL_RETIRED_EXPORT_MANIFEST").unwrap());
        let slots: Vec<String> = state::read_bounded(&manifest, 1024 * 1024)?;
        assert!(!slots.is_empty() && slots.len() <= 4096);
        let guest = OwnedGuest::connect_cleanup(&candidate)?;
        for slot in &slots {
            let intent = read_mode(&candidate, slot, guest.incarnation(), None, false)?;
            assert!(intent.graph.is_none());
            assert_ne!(intent.boot, guest.boot_id());
            absent(&guest, slot)?;
        }
        drop(guest);
        let mut receipts = Vec::new();
        for slot in slots {
            let original = bytes(&root(&candidate).join(format!("{slot}.json")))?;
            let receipt = export_retired(&candidate, &slot)?;
            assert_eq!(bytes(&receipt.path)?, original);
            receipts.push(receipt);
        }
        state::write(&manifest.with_extension("results.json"), &receipts)?;
        Ok(())
    }
}
