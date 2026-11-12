//! Bind an older owner's interrupted cleanup without replaying its Coordinator
//! admission or manufacturing an acknowledgement. A new dead-owner intent owns
//! the idempotent, independently fenced cleanup and preserves the old journal.
use super::*;
use crate::provider::{
    identity::ProcessIdentity,
    relay_owner::{
        lifecycle_intent::{Inspection, Phase},
        publication::dead,
    },
};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Selection {
    coordinator_sha256: String,
    fingerprint: String,
}
fn refused() -> CandidateError {
    error(
        "graph_cleanup_enrollment",
        "The selected legacy cleanup coordinator changed or cannot be bound to the dead graph owner. Run hack ps --json to inspect retained state.",
    )
}
impl Selection {
    /// A predecessor VM boot proves its guest processes absent independently.
    /// Preserve the old coordinator without executing or acknowledging it.
    pub(super) fn capture_previous(
        original: &Receipt,
        boot: &str,
        process: &ProcessIdentity,
    ) -> Result<Self, CandidateError> {
        let marker = original.relay_cleanup.as_ref().ok_or_else(refused)?;
        let inspected = Inspection::load(
            &marker.control_root,
            host_relay::context(&original.owner, boot)?,
        )?;
        bind(original, &inspected, process, None)?;
        let selected = Self {
            coordinator_sha256: raw_digest(original)?,
            fingerprint: inspected.recovery_fingerprint,
        };
        selected.validate(original)?;
        Ok(selected)
    }
    pub(super) fn verify_raw(&self, original: &Receipt) -> Result<(), CandidateError> {
        self.validate(original)?;
        if raw_digest(original)? != self.coordinator_sha256 {
            return Err(refused());
        }
        Ok(())
    }
    pub(super) fn validate(&self, original: &Receipt) -> Result<(), CandidateError> {
        if !hex(&self.coordinator_sha256, 64)
            || !hex(&self.fingerprint, 64)
            || original.relay_cleanup.as_ref().is_none_or(|marker| {
                !marker.valid()
                    || marker.phase != cleanup_enrollment::Phase::Pending
                    || original
                        .relay_startup
                        .as_ref()
                        .is_none_or(|startup| startup.control_root != marker.control_root)
            })
        {
            return Err(refused());
        }
        Ok(())
    }

    pub(super) fn capture(
        engine: &Engine<'_>,
        original: &Receipt,
        root: &Path,
        relay: &dead::CleanupWitness,
        process: &ProcessIdentity,
    ) -> Result<Option<Self>, CandidateError> {
        let Some(marker) = &original.relay_cleanup else {
            return Ok(None);
        };
        let context = host_relay::context(&original.owner, engine.guest().boot_id())?;
        let inspected = Inspection::load(&marker.control_root, context)?;
        relay.verify()?;
        bind(original, &inspected, process, relay.present_identity())?;
        let bridges = bridges::cleanup::read(engine, original, root)?;
        let environment =
            environment::cleanup_inventory(engine.guest().candidate(), engine, original, root)?;
        if host_relay::cleanup_effect(
            original,
            engine.guest().boot_id(),
            false,
            &(&environment, &bridges),
        )? != marker.effect
        {
            return Err(refused());
        }
        let selected = Self {
            coordinator_sha256: raw_digest(original)?,
            fingerprint: inspected.recovery_fingerprint,
        };
        selected.validate(original)?;
        Ok(Some(selected))
    }
}
fn raw_digest(original: &Receipt) -> Result<String, CandidateError> {
    let marker = original.relay_cleanup.as_ref().ok_or_else(refused)?;
    let bytes = host_pin_recovery::read_raw(
        &marker.control_root.join("relay-lifecycle/state.json"),
        128 * 1024,
    )?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn bind(
    original: &Receipt,
    inspected: &Inspection,
    process: &ProcessIdentity,
    present: Option<([u8; 16], [u8; 32])>,
) -> Result<(), CandidateError> {
    let marker = original.relay_cleanup.as_ref().ok_or_else(refused)?;
    let context = inspected.selection.context;
    if !marker.valid()
        || marker.phase != cleanup_enrollment::Phase::Pending
        || inspected.phase != Phase::EffectStarted
        || !inspected.acknowledgement_pending
        || !inspected.selection_observed
        || inspected.graph != Some(host_relay::graph_scope(context, &original.run)?)
        || inspected.selection.operation != marker.operation
        || inspected.selection.effect != marker.effect
        || context.runtime != marker.runtime
        || context.boot != marker.boot
        || &inspected.process != process
        || original
            .relay_startup
            .as_ref()
            .is_none_or(|startup| startup.control_root != marker.control_root)
        || present.is_some_and(|(owner, publication)| {
            owner != inspected.owner || publication != inspected.publication
        })
    {
        return Err(refused());
    }
    Ok(())
}
pub(super) fn verify(
    selected: Option<&Selection>,
    original: &Receipt,
    boot: &str,
    relay: &dead::CleanupWitness,
    process: &ProcessIdentity,
) -> Result<(), CandidateError> {
    let Some(selected) = selected else {
        return if original.relay_cleanup.is_none() {
            Ok(())
        } else {
            Err(refused())
        };
    };
    selected.validate(original)?;
    let marker = original.relay_cleanup.as_ref().ok_or_else(refused)?;
    let inspected = Inspection::load(
        &marker.control_root,
        host_relay::context(&original.owner, boot)?,
    )?;
    relay.verify()?;
    bind(original, &inspected, process, relay.present_identity())?;
    if raw_digest(original)? != selected.coordinator_sha256
        || inspected.recovery_fingerprint != selected.fingerprint
    {
        return Err(refused());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next13_writer_coordinator_binds_without_rewriting_its_evidence() {
        use std::os::unix::fs::MetadataExt;
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("next13-enrollment-{}", std::process::id()));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let control = root.join("relay-lifecycle");
        state::private_directory(&control).unwrap();
        let parent = fs::metadata(&control).unwrap();
        let mut original: Receipt = serde_json::from_str(include_str!(
            "../../../../../tests/fixtures/native-next13/ready-pending.json"
        ))
        .unwrap();
        original.relay_startup.as_mut().unwrap().control_root = root.clone();
        let context = host_relay::context(&original.owner, "old-boot").unwrap();
        let marker = original.relay_cleanup.as_mut().unwrap();
        marker.control_root = root.clone();
        marker.runtime = context.runtime;
        marker.boot = context.boot;
        let mut record: Value = serde_json::from_str(include_str!(
            "../../../../../tests/fixtures/native-next13/coordinator.json"
        ))
        .unwrap();
        record["parent"] = json!([parent.dev(), parent.ino()]);
        record["runtime"] = json!(context.runtime);
        record["boot"] = json!(context.boot);
        let mut graph = Sha256::new();
        graph.update(b"Hack graph relay scope v1\0");
        graph.update(context.runtime);
        graph.update(original.run.as_bytes());
        let graph: [u8; 32] = graph.finalize().into();
        record["graph"] = json!(graph);
        record["process"]["uid"] = json!(unsafe { libc::geteuid() });
        state::write(&control.join("state.json"), &record).unwrap();
        let process: ProcessIdentity = serde_json::from_value(record["process"].clone()).unwrap();
        let bytes = fs::read(control.join("state.json")).unwrap();
        // Observation never creates missing locks, even for a valid old journal.
        assert!(Selection::capture_previous(&original, "old-boot", &process).is_err());
        drop(state::Lock::acquire(&control).unwrap());
        let selected = Selection::capture_previous(&original, "old-boot", &process).unwrap();
        selected.verify_raw(&original).unwrap();
        assert_eq!(fs::read(control.join("state.json")).unwrap(), bytes);
        let mut wrong = process;
        wrong.start_micros += 1;
        assert!(Selection::capture_previous(&original, "old-boot", &wrong).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn legacy_enrollment_binds_exact_dead_owner_and_operation() {
        // This is the unchanged next.13 Pending marker. No recovery fields or
        // migration written by the new binary are needed to select it.
        let mut original: Receipt = serde_json::from_value(json!({
            "version":1,"run":"a".repeat(32),"owner":"b".repeat(32),
            "namespace":"c".repeat(64),"plan_id":"d".repeat(64),
            "phase":"ready-observed","readiness":{},"resources":{},
            "relay_startup":{"control_only":true,"guest_root":null,"control_root":"/private/owned","artifact":"e".repeat(64),"services":{}},
            "relay_cleanup":{"version":1,"runtime":([1;16]),"boot":([2;16]),
                "operation":([3;16]),"effect":([4;32]),"control_root":"/private/owned",
                "phase":"pending"}
        }))
        .unwrap();
        let process = ProcessIdentity {
            pid: 42,
            start_micros: 123,
            uid: 1000,
            executable: "/runtime".into(),
        };
        let context = crate::provider::relay_owner::Context {
            runtime: [1; 16],
            boot: [2; 16],
        };
        let mut inspection = Inspection {
            selection: crate::provider::relay_owner::lifecycle_intent::Selection {
                context,
                operation: [3; 16],
                effect: [4; 32],
            },
            phase: Phase::EffectStarted,
            targets: vec![],
            graph: Some(host_relay::graph_scope(context, &original.run).unwrap()),
            selection_observed: true,
            acknowledgement_pending: true,
            owner: [5; 16],
            process: process.clone(),
            publication: [6; 32],
            recovery_fingerprint: "e".repeat(64),
        };
        let present = Some((inspection.owner, inspection.publication));
        bind(&original, &inspection, &process, present).unwrap();
        bind(&original, &inspection, &process, None).unwrap();
        let mut reused = process.clone();
        reused.start_micros += 1;
        assert!(bind(&original, &inspection, &reused, present).is_err());
        assert!(bind(&original, &inspection, &process, Some(([9; 16], [6; 32]))).is_err());
        inspection.selection.operation[0] += 1;
        assert!(bind(&original, &inspection, &process, present).is_err());
        inspection.selection.operation[0] -= 1;
        for phase in [Phase::Intent, Phase::Confirmed] {
            inspection.phase = phase;
            assert!(bind(&original, &inspection, &process, present).is_err());
        }
        inspection.phase = Phase::EffectStarted;
        inspection.acknowledgement_pending = false;
        assert!(bind(&original, &inspection, &process, present).is_err());
        inspection.acknowledgement_pending = true;
        original.relay_cleanup.as_mut().unwrap().phase = cleanup_enrollment::Phase::Confirmed;
        assert!(bind(&original, &inspection, &process, present).is_err());
    }
}
