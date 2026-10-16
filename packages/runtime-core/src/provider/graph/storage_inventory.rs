//! Bounded volume inventory under the graph mutation lease. No collection effects.
use super::*;
use std::{path::Path, time::Instant};

pub(super) fn runs(parent: &Path) -> Result<Vec<String>, CandidateError> {
    if !parent.exists() && !parent.is_symlink() {
        return Ok(Vec::new());
    }
    state::check_private_directory(parent)?;
    let mut runs = Vec::new();
    for entry in fs::read_dir(parent).map_err(state::io)?.take(65) {
        let entry = entry.map_err(state::io)?;
        let name = entry.file_name().into_string().map_err(|_| {
            error(
                "graph_storage_inventory",
                "Invalid retained graph directory.",
            )
        })?;
        if runs.len() == 64 || !hex(&name, 32) {
            return Err(error(
                "graph_storage_inventory",
                "Graph inventory exceeds 64 attempts or contains unknown entries.",
            ));
        }
        state::check_private_directory(&entry.path())?;
        runs.push(name);
    }
    runs.sort();
    Ok(runs)
}

fn budget(started: Instant) -> Result<(), CandidateError> {
    if started.elapsed() > Duration::from_secs(10) {
        return Err(error(
            "graph_storage_budget",
            "Storage inventory exceeded ten seconds between operations; no collection performed.",
        ));
    }
    Ok(())
}

pub fn inventory(candidate: &Candidate) -> Result<Value, CandidateError> {
    let engine = Engine::connect_cleanup(candidate)?;
    let started = Instant::now();
    let mut references = BTreeMap::new();
    let mut graphs = Vec::new();
    for run in runs(&candidate.state_root.join("run/graphs"))? {
        budget(started)?;
        let (receipt, root) = load(candidate, &engine, &run)?;
        let pending =
            root.join("state.pending").exists() || root.join("state.pending").is_symlink();
        let mut observations = BTreeMap::new();
        for (key, resource) in &receipt.resources {
            if resource.kind != Kind::Volume {
                continue;
            }
            budget(started)?;
            let present = inspect_resource(&engine, &receipt, resource)?.is_some();
            observations.insert(
                key.clone(),
                json!({"state":if present {"present"} else {"absent"}}),
            );
        }
        let report = storage::references(&receipt, pending, &observations);
        for volume in report["volumes"].as_array().expect("volume references") {
            let name = volume["name"].as_str().expect("volume name");
            if references.insert(name.to_owned(), json!({"run":run,"classification":volume["classification"],"observed_state":volume["observed_state"]})).is_some() {
                return Err(error("graph_storage_inventory", "Duplicate retained volume identity."));
            }
        }
        graphs.push(report);
    }
    budget(started)?;
    let usage = super::super::guest_storage::decode(engine.request(
        Method::GET,
        "/v1.53/system/df?verbose=true",
        None,
    )?)?;
    budget(started)?;
    let volumes = join(&usage["categories"]["volumes"]["items"], &references)?;
    Ok(json!({
        "scope":"retained_graph_store_and_private_engine_volumes",
        "atomic_snapshot":false,
        "graph_mutations_excluded":true,
        "branch_registry_checked":false,
        "archived_removed_graphs_scanned":false,
        "cleanup_authorized":false,
        "deletion_candidates":[],
        "graphs":graphs,
        "volumes":volumes,
        "engine_volume_summary":usage["categories"]["volumes"],
        "elapsed_ms":started.elapsed().as_millis()
    }))
}

fn join(items: &Value, references: &BTreeMap<String, Value>) -> Result<Vec<Value>, CandidateError> {
    let mut present = std::collections::BTreeSet::new();
    let mut volumes = Vec::new();
    for item in items.as_array().expect("decoded volume items") {
        let name = item["name"].as_str().expect("decoded volume name");
        present.insert(name);
        let reference = references.get(name);
        if reference.is_some_and(|r| r["observed_state"] != "present") {
            return Err(error(
                "graph_storage_changed",
                "Volume presence changed during inventory.",
            ));
        }
        volumes.push(json!({
            "name":name,
            "bytes":item["bytes"],
            "container_references":item["container_references"],
            "graph_reference":reference,
            "disposition":"retain",
            "reason":if reference.is_some() {"persistent_graph_data"} else {"ownership_or_non_graph_references_unclassified"}
        }));
    }
    if references.iter().any(|(name, reference)| {
        reference["observed_state"] == "present" && !present.contains(name.as_str())
    }) {
        return Err(error(
            "graph_storage_changed",
            "Referenced volume disappeared during inventory.",
        ));
    }
    Ok(volumes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn unknown_and_zero_reference_persistent_volumes_are_retained() {
        let items = json!([{"name":"data","bytes":36,"container_references":0},{"name":"foreign","bytes":123,"container_references":0}]);
        let references = BTreeMap::from([(
            "data".into(),
            json!({"run":"a","classification":"retained_for_restore","observed_state":"present"}),
        )]);
        let result = join(&items, &references).unwrap();
        assert_eq!(
            result[0]["graph_reference"]["classification"],
            "retained_for_restore"
        );
        assert_eq!(result[0]["disposition"], "retain");
        assert_eq!(result[1]["disposition"], "retain");
        assert_eq!(result[1]["graph_reference"], Value::Null);
        assert!(join(&json!([]), &references).is_err());
        let absent = BTreeMap::from([("data".into(), json!({"observed_state":"absent"}))]);
        assert!(join(&items, &absent).is_err());
        assert!(join(&json!([]), &absent).is_ok());
    }

    #[test]
    fn enumeration_is_bounded_and_refuses_unknown_or_aliased_entries() {
        let fixture = super::super::tests::Fixture::new();
        let parent = fixture.0.join("graphs");
        assert!(runs(&parent).unwrap().is_empty());
        assert!(!parent.exists());
        state::private_directory(&parent).unwrap();
        for index in 0..64 {
            state::private_directory(&parent.join(format!("{index:032x}"))).unwrap();
        }
        assert_eq!(runs(&parent).unwrap().len(), 64);
        let extra = parent.join("f".repeat(32));
        state::private_directory(&extra).unwrap();
        assert!(runs(&parent).is_err());
        fs::remove_dir(&extra).unwrap();
        fs::remove_dir(parent.join(format!("{:032x}", 0))).unwrap();
        symlink(&fixture.0, &extra).unwrap();
        assert!(runs(&parent).is_err());
        fs::remove_file(&extra).unwrap();
        fs::write(parent.join("unknown"), b"preserve").unwrap();
        assert!(runs(&parent).is_err());
        assert_eq!(fs::read(parent.join("unknown")).unwrap(), b"preserve");
    }
}
