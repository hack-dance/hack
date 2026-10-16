//! Graph intent complements engine reference counts; neither grants deletion authority.
use super::{Kind, Receipt};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(super) fn references(
    receipt: &Receipt,
    journal_incomplete: bool,
    observations: &BTreeMap<String, Value>,
) -> Value {
    let volumes: Vec<Value> = receipt
        .resources
        .iter()
        .filter(|(_, resource)| resource.kind == Kind::Volume)
        .map(|(key, resource)| {
            let observed = observations.get(key).and_then(|v| v["state"].as_str());
            let classification = classify(
                &receipt.phase,
                &resource.phase,
                journal_incomplete,
                observed,
            );
            json!({
                "name":resource.name,
                "resource":resource.key,
                "kind":"persistent_data",
                "classification":classification,
                "observed_state":observed,
                "automatic_collection_allowed":false
            })
        })
        .collect();
    json!({
        "scope":"single_graph_persistent_volume_intent",
        "run":receipt.run,
        "owner":receipt.owner,
        "graph_phase":receipt.phase,
        "journal_incomplete":journal_incomplete,
        "cross_graph_references_checked":false,
        "cleanup_authorized":false,
        "volumes":volumes
    })
}

fn classify(graph: &str, resource: &str, pending: bool, observed: Option<&str>) -> &'static str {
    if pending {
        return "recovery_required";
    }
    match (graph, resource, observed) {
        ("removed", "absent", Some("absent")) => "confirmed_removed",
        ("stopped-data-retained", "created", Some("present")) => "retained_for_restore",
        ("ready-observed", "created", Some("present")) => "referenced_by_graph",
        ("stopped-data-retained" | "ready-observed", "created", Some("absent")) => {
            "expected_data_missing"
        }
        _ => "recovery_required",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_cleanup_retains_intent_even_without_containers() {
        assert_eq!(
            classify("stopped-data-retained", "created", false, Some("present")),
            "retained_for_restore"
        );
        assert_eq!(
            classify("ready-observed", "created", false, Some("present")),
            "referenced_by_graph"
        );
        assert_eq!(
            classify("removed", "absent", false, Some("absent")),
            "confirmed_removed"
        );
    }

    #[test]
    fn missing_data_and_interrupted_operations_never_become_disposable() {
        for phase in ["ready-observed", "stopped-data-retained"] {
            assert_eq!(
                classify(phase, "created", false, Some("absent")),
                "expected_data_missing"
            );
            assert_eq!(
                classify(phase, "created", true, Some("present")),
                "recovery_required"
            );
        }
        for phase in [
            "preparing",
            "cleanup-intent",
            "restoring",
            "failed-retained",
        ] {
            for observed in [None, Some("present"), Some("absent")] {
                assert_eq!(
                    classify(phase, "created", false, observed),
                    "recovery_required"
                );
            }
        }
        assert_eq!(
            classify("removed", "absent", false, Some("present")),
            "recovery_required"
        );
        assert_eq!(
            classify("removed", "absent", true, Some("absent")),
            "recovery_required"
        );
    }
}
