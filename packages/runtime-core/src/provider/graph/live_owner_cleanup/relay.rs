//! Persist absence as a selected locked-directory/process witness, never as a
//! substitute relay acknowledgement or a fallback from invalid publication.
use super::*;
use crate::provider::identity::ProcessIdentity;

/// The untagged present variant preserves version-one recovery records exactly.
#[derive(Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub(super) enum Selection {
    Present(dead::Selection),
    Absent { absent: Absent },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Absent {
    process: ProcessIdentity,
    witness_sha256: String,
}

impl Selection {
    pub(super) fn capture(
        witness: &dead::CleanupWitness,
        process: &ProcessIdentity,
    ) -> Result<Self, CandidateError> {
        Ok(match witness.present_selection() {
            Some(selected) => Self::Present(selected),
            None => Self::Absent {
                absent: Absent {
                    process: process.clone(),
                    witness_sha256: witness.selection_sha256()?,
                },
            },
        })
    }

    pub(super) fn version(&self) -> u8 {
        match self {
            Self::Present(_) => 1,
            Self::Absent { .. } => 2,
        }
    }

    pub(super) fn validate(&self) -> Result<(), CandidateError> {
        if let Self::Absent { absent } = self {
            // SAFETY: geteuid takes no arguments.
            crate::provider::identity::verify(
                &absent.process,
                &absent.process,
                &absent.process.executable,
                unsafe { libc::geteuid() },
            )?;
            if !absent.process.executable.is_absolute() || !hex(&absent.witness_sha256, 64) {
                return Err(refused());
            }
        }
        Ok(())
    }

    pub(super) fn verify(
        &self,
        witness: &dead::CleanupWitness,
        process: &ProcessIdentity,
    ) -> Result<(), CandidateError> {
        witness.verify()?;
        match (self, witness.present_selection()) {
            (Self::Present(expected), Some(current)) if *expected == current => Ok(()),
            (Self::Absent { absent }, None)
                if absent.process == *process
                    && absent.witness_sha256 == witness.selection_sha256()? =>
            {
                Ok(())
            }
            _ => Err(refused()),
        }
    }

    /// Reacquire the original absence lock through publication retirement. There
    /// is deliberately no unlink operation for an absent selection.
    pub(super) fn absent_witness(
        &self,
        candidate: &Candidate,
        receipt: &Receipt,
        boot: &str,
        process: &ProcessIdentity,
    ) -> Result<Option<dead::CleanupWitness>, CandidateError> {
        let Self::Absent { absent } = self else {
            return Ok(None);
        };
        require_scoped_root(candidate, receipt, boot)?;
        let startup = receipt.relay_startup.as_ref().ok_or_else(refused)?;
        let witness = dead::CleanupWitness::acquire(
            &startup.control_root,
            host_relay::context(&receipt.owner, boot)?,
            &absent.process,
        )?;
        self.verify(&witness, process)?;
        Ok(Some(witness))
    }
}

/// A ready receipt and its exact foreground process bind the otherwise absent
/// endpoint to this run. Legacy unscoped roots cannot establish that binding.
pub(super) fn require_scoped_root(
    candidate: &Candidate,
    receipt: &Receipt,
    boot: &str,
) -> Result<(), CandidateError> {
    let expected = startup::control_root(
        &candidate.state_root,
        &receipt.owner,
        Some(boot),
        Some(&receipt.run),
    )?;
    if receipt
        .relay_startup
        .as_ref()
        .ok_or_else(refused)?
        .control_root
        != expected
    {
        return Err(refused());
    }
    Ok(())
}

/// Retain the raw-byte selection: parsing and reserializing must not hide an
/// external replacement. Only canonical receipt commits from owned cleanup may
/// advance phase; immutable run/resource/startup identities cannot change.
pub(super) fn verify_receipt(root: &Path, original: &Receipt) -> Result<(), CandidateError> {
    let bytes = host_pin_recovery::read_raw(&root.join("state.json"), 2 * 1024 * 1024)?;
    let current: Receipt = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if bytes != serde_json::to_vec_pretty(&current).map_err(|_| refused())?
        || immutable(&current)? != immutable(original)?
        || !matches!(
            current.phase.as_str(),
            "ready-observed" | "cleanup-intent" | "stopped-data-retained"
        )
    {
        return Err(refused());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{identity, relay_owner::Context};
    use std::{
        os::unix::fs::DirBuilderExt,
        process::{Child, Command, Stdio},
    };

    struct Process(Child);
    impl Drop for Process {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn selected_absence_refuses_live_process_partial_publication_and_recreated_endpoint() {
        let candidate_root = super::super::super::tests::Fixture::new();
        let candidate = Candidate::discover(&candidate_root.0).unwrap();
        let mut receipt: Receipt = serde_json::from_value(json!({
            "version":1,"run":"a".repeat(32),"owner":"b".repeat(32),
            "namespace":"c".repeat(64),"plan_id":"d".repeat(64),
            "phase":"ready-observed","readiness":{},"resources":{},
            "relay_startup":{"control_only":true,"guest_root":null,
                "control_root":"/private/foreign","artifact":"e".repeat(64),"services":{}}
        }))
        .unwrap();
        let boot = "11111111-1111-1111-1111-111111111111";
        assert!(require_scoped_root(&candidate, &receipt, boot).is_err());
        let root = startup::control_root(
            &candidate.state_root,
            &receipt.owner,
            Some(boot),
            Some(&receipt.run),
        )
        .unwrap();
        // Exclusive creation and the fixture's unique state root scope this
        // disposable control directory; the test never touches a runtime home.
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let root = super::super::super::tests::Fixture(root);
        receipt.relay_startup.as_mut().unwrap().control_root = root.0.clone();
        require_scoped_root(&candidate, &receipt, boot).unwrap();
        assert!(require_scoped_root(&candidate, &receipt, "changed-boot").is_err());
        let context = Context {
            runtime: [1; 16],
            boot: [2; 16],
        };
        let control = root.0.join("relay-control");
        fs::DirBuilder::new().mode(0o700).create(&control).unwrap();
        let lock = state::Lock::acquire(&control).unwrap();
        drop(lock);
        let mut child = Process(
            Command::new("/bin/sleep")
                .arg("60")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let process = identity::observe(child.0.id() as i32).unwrap();
        assert!(dead::CleanupWitness::acquire(&root.0, context, &process).is_err());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let witness = dead::CleanupWitness::acquire(&root.0, context, &process).unwrap();
        let selected = Selection::capture(&witness, &process).unwrap();
        assert_eq!(selected.version(), 2);
        selected.verify(&witness, &process).unwrap();
        let restored: Selection =
            serde_json::from_slice(&serde_json::to_vec(&selected).unwrap()).unwrap();
        restored.verify(&witness, &process).unwrap();
        let mut changed_process = process.clone();
        changed_process.start_micros += 1;
        assert!(restored.verify(&witness, &changed_process).is_err());
        fs::write(control.join("owner.json"), b"foreign").unwrap();
        assert!(restored.verify(&witness, &process).is_err());
        drop(witness);
        assert!(dead::CleanupWitness::acquire(&root.0, context, &process).is_err());
        fs::remove_file(control.join("owner.json")).unwrap();
        let witness = dead::CleanupWitness::acquire(&root.0, context, &process).unwrap();
        restored.verify(&witness, &process).unwrap();
        let endpoint =
            std::os::unix::net::UnixListener::bind(control.join("control.sock")).unwrap();
        assert!(restored.verify(&witness, &process).is_err());
        drop(endpoint);
        fs::remove_file(control.join("control.sock")).unwrap();
        restored.verify(&witness, &process).unwrap();
        drop(witness);
        let resumed = restored
            .absent_witness(&candidate, &receipt, boot, &process)
            .unwrap()
            .unwrap();
        restored.verify(&resumed, &process).unwrap();
        drop(resumed);
        let substituted =
            dead::CleanupWitness::acquire(&root.0, context, &changed_process).unwrap();
        let self_consistent = Selection::capture(&substituted, &changed_process).unwrap();
        self_consistent
            .verify(&substituted, &changed_process)
            .unwrap();
        assert!(self_consistent.verify(&substituted, &process).is_err());
        drop(substituted);
        assert!(
            self_consistent
                .absent_witness(&candidate, &receipt, boot, &process)
                .is_err()
        );
        fs::rename(
            control.join("operation.lock"),
            control.join("original.lock"),
        )
        .unwrap();
        drop(state::Lock::acquire(&control).unwrap());
        let replacement = dead::CleanupWitness::acquire(&root.0, context, &process).unwrap();
        assert!(restored.verify(&replacement, &process).is_err());
    }
}
