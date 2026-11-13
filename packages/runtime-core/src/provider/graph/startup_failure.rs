//! Value-free historical failure evidence, independent of container retention.
use super::{Kind, Receipt, error, hex};
use crate::{
    CandidateError,
    project::execution::{Condition, Observation},
};
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "macos", test))]
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub service: String,
    pub container: String,
    pub observation: Observation,
}
impl Failure {
    pub(super) fn valid(&self, receipt: &Receipt) -> bool {
        !self.service.is_empty()
            && self.service.len() <= 128
            && self
                .service
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            && hex(&self.container, 64)
            && (self.observation.failed()
                || (self.observation == Observation::Exited { code: 0 }
                    && matches!(
                        receipt.readiness.get(&self.service),
                        Some(Condition::Started | Condition::Healthy)
                    )))
            && receipt
                .resources
                .get(&format!("container:{}", self.service))
                .is_some_and(|resource| resource.kind == Kind::Container)
    }
}
pub(super) fn record(
    receipt: &mut Receipt,
    service: &str,
    observation: Observation,
) -> Result<(), CandidateError> {
    let failure = Failure {
        service: service.into(),
        container: receipt
            .resources
            .get(&format!("container:{service}"))
            .and_then(|resource| resource.id.clone())
            .ok_or_else(refused)?,
        observation,
    };
    if !failure.valid(receipt) {
        return Err(refused());
    }
    receipt.startup_failure = Some(failure);
    Ok(())
}
/// Fold in pre-stop evidence only for the same container, keeping the first
/// recorded failure. False is diagnostic only; it must not obstruct cleanup.
#[cfg(any(target_os = "macos", test))]
pub(super) fn capture_for_cleanup(receipt: &mut Receipt, failure: Failure) -> bool {
    if receipt.startup_failure.is_some() {
        return true;
    }
    if !failure.valid(receipt)
        || receipt
            .resources
            .get(&format!("container:{}", failure.service))
            .and_then(|resource| resource.id.as_deref())
            != Some(failure.container.as_str())
    {
        return false;
    }
    receipt.startup_failure = Some(failure);
    true
}

/// Diagnostics must not abort cleanup when the frontend's stderr pipe is gone.
#[cfg(target_os = "macos")]
pub(super) fn unrecorded() {
    write_unrecorded(&mut std::io::stderr());
}
#[cfg(any(target_os = "macos", test))]
fn write_unrecorded(output: &mut impl std::io::Write) {
    let _ = writeln!(
        output,
        "startup_failure_unrecorded: listener failure evidence could not be retained before cleanup."
    );
}
#[cfg(any(target_os = "macos", test))]
pub(super) fn preserve_listener_error(
    root: &Path,
    receipt: &mut Receipt,
    service: &str,
    observation: Observation,
    error: CandidateError,
) -> CandidateError {
    match record(receipt, service, observation)
        .and_then(|()| super::state::write(&root.join("state.json"), receipt))
    {
        Ok(()) => error,
        Err(diagnostic) => error.with_cause_code(diagnostic.code.into()),
    }
}
fn refused() -> CandidateError {
    error(
        "graph_receipt",
        "Startup failure identity cannot be confirmed.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn receipt() -> Receipt {
        serde_json::from_value(json!({"version":1,"run":"a".repeat(32),"owner":"b".repeat(32),"namespace":"c".repeat(64),"plan_id":"d".repeat(64),"phase":"preparing","readiness":{"redis":"started"},"resources":{"container:redis":{"key":"redis","kind":"container","name":format!("hkg-{}-container-0", "a".repeat(32)),"id":"e".repeat(64),"phase":"started","image":format!("sha256:{}", "f".repeat(64))}}})).unwrap()
    }
    #[test]
    fn lost_diagnostic_pipe_does_not_abort_cleanup_evidence_handling() {
        use std::os::unix::net::UnixStream;
        let (mut writer, reader) = UnixStream::pair().unwrap();
        drop(reader);
        write_unrecorded(&mut writer);
        let mut cleaned = receipt();
        record(&mut cleaned, "redis", Observation::Exited { code: 7 }).unwrap();
        cleaned.phase = "stopped-data-retained".into();
        cleaned.resources.get_mut("container:redis").unwrap().id = None;
        let root = super::super::tests::Fixture::new();
        crate::provider::state::write(&root.0.join("state.json"), &cleaned).unwrap();
        assert!(super::super::load_at(root.0.clone(), &cleaned.run, &cleaned.owner).is_ok());
    }
    #[test]
    fn cleanup_capture_keeps_first_failure_and_refuses_replaced_container_without_writing() {
        let mut original = receipt();
        record(&mut original, "redis", Observation::Exited { code: 7 }).unwrap();
        let first = original.startup_failure.clone().unwrap();
        let mut later = first.clone();
        later.observation = Observation::Exited { code: 8 };
        assert!(capture_for_cleanup(&mut original, later));
        assert_eq!(original.startup_failure, Some(first.clone()));
        let mut replaced = receipt();
        replaced.resources.get_mut("container:redis").unwrap().id = Some("9".repeat(64));
        let bytes = serde_json::to_vec(&replaced).unwrap();
        assert!(!capture_for_cleanup(&mut replaced, first.clone()));
        assert_eq!(serde_json::to_vec(&replaced).unwrap(), bytes);
        let mut current = receipt();
        assert!(capture_for_cleanup(&mut current, first.clone()));
        assert!(capture_for_cleanup(&mut current, first.clone()));
        assert_eq!(current.startup_failure, Some(first));
    }
    #[test]
    fn failure_survives_cleanup_and_legacy_receipts_remain_readable() {
        let mut receipt = receipt();
        assert!(receipt.startup_failure.is_none());
        record(&mut receipt, "redis", Observation::Exited { code: 10 }).unwrap();
        receipt.phase = "stopped-data-retained".into();
        receipt.resources.get_mut("container:redis").unwrap().id = None;
        let retained: Receipt =
            serde_json::from_slice(&serde_json::to_vec(&receipt).unwrap()).unwrap();
        let failure = retained.startup_failure.as_ref().unwrap();
        assert!(failure.valid(&retained));
        assert_eq!(failure.container, "e".repeat(64));
        assert_eq!(failure.observation, Observation::Exited { code: 10 });
        let root = super::super::tests::Fixture::new();
        crate::provider::state::write(&root.0.join("state.json"), &retained).unwrap();
        assert!(super::super::load_at(root.0.clone(), &retained.run, &retained.owner).is_ok());
        let mut invalid = retained.clone();
        invalid.startup_failure.as_mut().unwrap().service = "foreign".into();
        crate::provider::state::write(&root.0.join("state.json"), &invalid).unwrap();
        assert!(super::super::load_at(root.0.clone(), &invalid.run, &invalid.owner).is_err());
    }
    #[test]
    fn only_failed_owned_service_observations_are_recorded() {
        let mut receipt = receipt();
        assert!(record(&mut receipt, "redis", Observation::Created).is_err());
        assert!(record(&mut receipt, "foreign", Observation::Dead).is_err());
        receipt.resources.get_mut("container:redis").unwrap().id = Some("invalid".into());
        assert!(record(&mut receipt, "redis", Observation::Dead).is_err());
        assert!(receipt.startup_failure.is_none());
    }
    #[test]
    fn required_listener_zero_exit_survives_cleanup() {
        for condition in [Condition::Started, Condition::Healthy] {
            let mut receipt = receipt();
            receipt.readiness.insert("redis".into(), condition);
            record(&mut receipt, "redis", Observation::Exited { code: 0 }).unwrap();
            receipt.phase = "stopped-data-retained".into();
            receipt.resources.get_mut("container:redis").unwrap().id = None;
            let root = super::super::tests::Fixture::new();
            crate::provider::state::write(&root.0.join("state.json"), &receipt).unwrap();
            let (retained, _) =
                super::super::load_at(root.0.clone(), &receipt.run, &receipt.owner).unwrap();
            let failure = retained.startup_failure.as_ref().unwrap();
            assert_eq!(failure.service, "redis");
            assert_eq!(failure.container, "e".repeat(64));
            assert_eq!(failure.observation, Observation::Exited { code: 0 });
        }
    }
    #[test]
    fn successful_completion_is_not_startup_failure_evidence() {
        let mut receipt = receipt();
        receipt
            .readiness
            .insert("redis".into(), Condition::Completed);
        assert!(record(&mut receipt, "redis", Observation::Exited { code: 0 }).is_err());
        receipt.readiness.clear();
        assert!(record(&mut receipt, "redis", Observation::Exited { code: 0 }).is_err());
        assert!(receipt.startup_failure.is_none());
    }
    #[test]
    fn failed_evidence_write_preserves_original_error_and_pending_bytes() {
        let root = super::super::tests::Fixture::new();
        let pending = root.0.join("state.pending");
        std::fs::write(&pending, b"retained pending evidence").unwrap();
        let mut receipt = receipt();
        let error = preserve_listener_error(
            &root.0,
            &mut receipt,
            "redis",
            Observation::Exited { code: 0 },
            CandidateError::new("graph_startup_listener_unexpected_exit", "Startup failed."),
        );
        assert_eq!(error.code, "graph_startup_listener_unexpected_exit");
        assert_eq!(error.cause_code.as_deref(), Some("provider_state"));
        assert_eq!(error.message, "Startup failed.");
        assert_eq!(
            std::fs::read(&pending).unwrap(),
            b"retained pending evidence"
        );
        assert!(!root.0.join("state.json").exists());
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("state.pending")
        );
    }
}
