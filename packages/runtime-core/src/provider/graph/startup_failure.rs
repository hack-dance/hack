//! Value-free historical failure evidence, independent of container retention.
use super::{Kind, Receipt, error, hex};
use crate::{CandidateError, project::execution::Observation};
use serde::{Deserialize, Serialize};

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
            && self.observation.failed()
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
        for state in [Observation::Created, Observation::Exited { code: 0 }] {
            assert!(record(&mut receipt, "redis", state).is_err());
        }
        assert!(record(&mut receipt, "foreign", Observation::Dead).is_err());
        receipt.resources.get_mut("container:redis").unwrap().id = Some("invalid".into());
        assert!(record(&mut receipt, "redis", Observation::Dead).is_err());
        assert!(receipt.startup_failure.is_none());
    }
}
