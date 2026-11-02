//! Read-only presentation of a pending cleanup, never recovery authority.
use super::{Kind, Receipt, cleanup_enrollment};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum KindHint {
    InterruptedStartupCandidate,
    PartialShutdown,
    Unclassified,
}

#[derive(Serialize)]
pub struct PendingCleanup {
    version: u8,
    kind: KindHint,
}

/// A failed-created start must still pass the dedicated native selection. A
/// started-container cleanup cannot use that selection merely because an older
/// completed startup journal remains. Unknown observations stay unclassified.
pub(super) fn pending(
    receipt: &Receipt,
    observations: &BTreeMap<String, Value>,
    journal_incomplete: bool,
) -> Option<PendingCleanup> {
    if receipt.phase != "cleanup-intent"
        || receipt
            .relay_cleanup
            .as_ref()
            .is_none_or(|marker| marker.phase != cleanup_enrollment::Phase::Pending)
    {
        return None;
    }
    let containers = receipt
        .resources
        .iter()
        .filter(|(_, resource)| resource.kind == Kind::Container)
        .collect::<Vec<_>>();
    let kind = if journal_incomplete || containers.is_empty() {
        KindHint::Unclassified
    } else if containers.iter().any(|(key, resource)| {
        resource.phase == "uncertain"
            && observations
                .get(*key)
                .is_some_and(|value| value["state"] == "created")
    }) {
        KindHint::InterruptedStartupCandidate
    } else if containers.iter().all(|(key, resource)| {
        resource.phase == "started"
            && observations.get(*key).is_some_and(|value| {
                matches!(
                    value["state"].as_str(),
                    Some("running" | "exited" | "absent")
                )
            })
    }) {
        KindHint::PartialShutdown
    } else {
        KindHint::Unclassified
    };
    Some(PendingCleanup { version: 1, kind })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn receipt() -> Receipt {
        serde_json::from_value(json!({
            "version":1,"run":"a".repeat(32),"owner":"b".repeat(32),
            "namespace":"c".repeat(64),"plan_id":"d".repeat(64),
            "phase":"cleanup-intent","readiness":{"web":"started","job":"completed"},
            "resources":{
                "container:web":{"kind":"container","key":"web","name":"selected-web","id":"e".repeat(64),"phase":"started"},
                "container:job":{"kind":"container","key":"job","name":"selected-job","id":"f".repeat(64),"phase":"started"}
            },
            "relay_cleanup":{"version":1,"runtime":vec![1;16],"boot":vec![2;16],"operation":vec![3;16],"effect":vec![4;32],"control_root":"/private/owned","phase":"pending"}
        })).unwrap()
    }

    fn observations() -> BTreeMap<String, Value> {
        BTreeMap::from([
            (
                "container:web".into(),
                json!({"state":"running","health":"healthy"}),
            ),
            ("container:job".into(), json!({"state":"exited","code":0})),
        ])
    }

    #[test]
    fn partially_stopped_started_graph_is_not_a_failed_start() {
        let receipt = receipt();
        let mut observations = observations();
        assert_eq!(
            pending(&receipt, &observations, false).unwrap().kind,
            KindHint::PartialShutdown
        );
        observations.insert("container:web".into(), json!({"state":"exited","code":137}));
        assert_eq!(
            pending(&receipt, &observations, false).unwrap().kind,
            KindHint::PartialShutdown
        );
        let encoded =
            serde_json::to_value(pending(&receipt, &observations, false).unwrap()).unwrap();
        assert_eq!(encoded, json!({"version":1,"kind":"partial_shutdown"}));
        assert!(!encoded.to_string().contains("selected-web"));
    }

    #[test]
    fn created_uncertainty_is_only_a_startup_candidate_not_eligibility() {
        let mut receipt = receipt();
        receipt.resources.get_mut("container:web").unwrap().phase = "uncertain".into();
        let mut observations = observations();
        observations.insert("container:web".into(), json!({"state":"created"}));
        assert_eq!(
            pending(&receipt, &observations, false).unwrap().kind,
            KindHint::InterruptedStartupCandidate
        );
        observations.insert("container:web".into(), json!({"state":"running"}));
        assert_eq!(
            pending(&receipt, &observations, false).unwrap().kind,
            KindHint::Unclassified
        );
    }

    #[test]
    fn missing_or_incomplete_evidence_stays_unclassified() {
        let receipt = receipt();
        let mut observations = observations();
        assert_eq!(
            pending(&receipt, &observations, true).unwrap().kind,
            KindHint::Unclassified
        );
        observations.remove("container:web");
        assert_eq!(
            pending(&receipt, &observations, false).unwrap().kind,
            KindHint::Unclassified
        );
        observations.insert(
            "container:web".into(),
            json!({"state":"synthetic-private-canary"}),
        );
        assert_eq!(
            serde_json::to_value(pending(&receipt, &observations, false)).unwrap(),
            json!({"version":1,"kind":"unclassified"})
        );
    }

    #[test]
    fn ordinary_and_completed_cleanup_has_no_pending_hint() {
        for phase in ["ready-observed", "failed-retained", "stopped-data-retained"] {
            let mut receipt = receipt();
            receipt.phase = phase.into();
            assert!(pending(&receipt, &observations(), false).is_none());
        }
        let mut receipt = receipt();
        receipt.relay_cleanup.as_mut().unwrap().phase = cleanup_enrollment::Phase::Confirmed;
        assert!(pending(&receipt, &observations(), false).is_none());
    }
}
