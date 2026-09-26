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
    let mut identities = BTreeMap::new();
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
            let logical = volume["resource"].as_str().expect("logical volume");
            let resource = &receipt.resources[&format!("volume:{logical}")];
            register_reference(&mut references, &mut identities, &run, resource, volume)?;
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

// Registration follows independent inspect_resource verification under the retained Engine lease.
// Repeated persistent identities are never accepted, even if their apparent state agrees.
fn register_reference(
    references: &mut BTreeMap<String, Value>,
    identities: &mut BTreeMap<String, (Option<dependency_cache::CacheBinding>, String)>,
    run: &str,
    resource: &Resource,
    volume: &Value,
) -> Result<(), CandidateError> {
    let refused = || {
        error(
            "graph_storage_inventory",
            "Conflicting retained volume references.",
        )
    };
    if resource.kind != Kind::Volume
        || volume["name"] != resource.name
        || volume["resource"] != resource.key
        || !matches!(
            volume["observed_state"].as_str(),
            Some("present" | "absent")
        )
        || resource
            .cache
            .as_ref()
            .is_some_and(|cache| !cache.valid() || cache.name() != resource.name)
    {
        return Err(refused());
    }
    let entry = json!({"run":run,"classification":volume["classification"],"observed_state":volume["observed_state"]});
    if let Some(prior) = references.get_mut(&resource.name) {
        let identity = identities.get(&resource.name).ok_or_else(refused)?;
        if resource.cache.is_none()
            || identity != &(resource.cache.clone(), resource.key.clone())
            || prior["observed_state"] != volume["observed_state"]
        {
            return Err(refused());
        }
        let refs = prior["graph_references"]
            .as_array_mut()
            .ok_or_else(refused)?;
        if refs.iter().any(|entry| entry["run"] == run) {
            return Err(refused());
        }
        refs.push(entry);
        // Single-reference compatibility fields are removed when they would misrepresent sharing.
        prior.as_object_mut().ok_or_else(refused)?.remove("run");
        prior["classification"] = json!("shared_dependency_cache_references");
    } else {
        let mut value = entry.clone();
        if let Some(cache) = &resource.cache {
            value["cache"] = serde_json::to_value(cache).map_err(|_| refused())?;
            value["graph_references"] = json!([entry]);
        }
        identities.insert(
            resource.name.clone(),
            (resource.cache.clone(), resource.key.clone()),
        );
        references.insert(resource.name.clone(), value);
    }
    Ok(())
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
            "reason":if reference.is_some_and(|r| r.get("cache").is_some()) {"shared_dependency_cache_no_collection_authority"} else if reference.is_some() {"persistent_graph_data"} else {"ownership_or_non_graph_references_unclassified"}
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
    fn shared_cache_registration_requires_exact_identity_and_consistent_observation() {
        let cache = dependency_cache::CacheBinding {
            scope: "a".repeat(64),
            fingerprint: "b".repeat(64),
            image: format!("sha256:{}", "c".repeat(64)),
        };
        let resource = Resource {
            routing: None,
            networks: None,
            outbound: false,
            cache: Some(cache.clone()),
            cache_provenance: None,
            kind: Kind::Volume,
            key: "deps".into(),
            name: cache.name(),
            id: None,
            image: None,
            phase: "created".into(),
        };
        let volume = json!({"name":resource.name,"resource":"deps","observed_state":"present","classification":"referenced_by_graph"});
        let mut references = BTreeMap::new();
        let mut identities = BTreeMap::new();
        register_reference(
            &mut references,
            &mut identities,
            "first",
            &resource,
            &volume,
        )
        .unwrap();
        let mut released = volume.clone();
        released["classification"] = json!("released_shared_cache_reference");
        register_reference(
            &mut references,
            &mut identities,
            "second",
            &resource,
            &released,
        )
        .unwrap();
        let refs = &references[&resource.name];
        assert_eq!(refs["graph_references"].as_array().unwrap().len(), 2);
        assert_eq!(
            refs["graph_references"][1]["classification"],
            "released_shared_cache_reference"
        );
        assert!(refs.get("run").is_none());
        let items = json!([{"name":resource.name,"bytes":99,"container_references":0}]);
        assert_eq!(
            join(&items, &references).unwrap()[0]["disposition"],
            "retain"
        );
        assert!(
            register_reference(
                &mut references,
                &mut identities,
                "second",
                &resource,
                &released
            )
            .is_err()
        );
        let mut absent = volume.clone();
        absent["observed_state"] = json!("absent");
        assert!(
            register_reference(
                &mut references,
                &mut identities,
                "third",
                &resource,
                &absent
            )
            .is_err()
        );
        let mut different = resource.clone();
        different.cache.as_mut().unwrap().scope = "d".repeat(64);
        assert!(
            register_reference(
                &mut references,
                &mut identities,
                "third",
                &different,
                &volume
            )
            .is_err()
        );
        different = resource.clone();
        different.key = "other".into();
        let mut other = volume.clone();
        other["resource"] = json!("other");
        assert!(
            register_reference(
                &mut references,
                &mut identities,
                "third",
                &different,
                &other
            )
            .is_err()
        );
        different = resource.clone();
        different.cache = None;
        assert!(
            register_reference(
                &mut references,
                &mut identities,
                "third",
                &different,
                &volume
            )
            .is_err()
        );
        let mut persistent = BTreeMap::new();
        let mut persistent_ids = BTreeMap::new();
        register_reference(
            &mut persistent,
            &mut persistent_ids,
            "first",
            &different,
            &volume,
        )
        .unwrap();
        assert!(
            register_reference(
                &mut persistent,
                &mut persistent_ids,
                "second",
                &different,
                &volume
            )
            .is_err()
        );
        assert_eq!(
            references[&resource.name]["graph_references"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

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
