use super::*;
use serde_json::{Map, Value};
mod fields;
mod graph;
mod service;
use fields::*;

pub(super) fn identifier(value: &str) -> Result<(), CandidateError> {
    fields::identifier(value)
}

pub(super) fn compile(
    candidate: &Candidate,
    project: &Path,
    base: &Path,
    file: &str,
    input: &[u8],
    profiles: &[String],
    value: Value,
) -> Result<PlanData, CandidateError> {
    let m = object(&value)?;
    let mut diagnostics = Vec::new();
    keys(
        m,
        &["services", "networks", "volumes", "name", "version"],
        "compose",
        &mut diagnostics,
    );
    if let Some(name) = m.get("name") {
        identifier(string(name)?)?;
        diagnostics.push(Diagnostic::warning("candidate_project_namespace","compose.name","The declared project name is replaced by a separate candidate namespace; no existing project is adopted."));
    }
    if m.contains_key("version") {
        diagnostics.push(Diagnostic::warning("obsolete_compose_version","compose.version","The legacy version field does not select a schema; this plan uses the explicit WU03 subset."));
    }
    let mut volumes = BTreeMap::new();
    if let Some(value) = m.get("volumes") {
        for (name, value) in object(value)? {
            identifier(name)?;
            let field = format!("volumes.{name}");
            let empty = Map::new();
            let v = if value.is_null() {
                &empty
            } else {
                object(value)?
            };
            keys(v, &["driver", "external"], &field, &mut diagnostics);
            if boolean(v.get("external"), false)? {
                diagnostics.push(Diagnostic::error(
                    "external_volume",
                    &field,
                    "External volumes cannot be adopted by candidate enrollment.",
                ));
            }
            let driver = v.get("driver").map(string).transpose()?.unwrap_or("local");
            if driver != "local" {
                diagnostics.push(Diagnostic::error(
                    "unsupported_volume_driver",
                    &field,
                    "Only owned local volumes are modeled.",
                ));
            }
            volumes.insert(name.clone(),VolumePlan {driver:if driver=="local" {"local".into()} else {"[unsupported]".into()},ownership:"new candidate namespace; retained on ordinary stop; no active v4 volume adoption".into()});
        }
    }
    let mut networks = BTreeMap::new();
    if let Some(value) = m.get("networks") {
        for (name, value) in object(value)? {
            identifier(name)?;
            let field = format!("networks.{name}");
            let empty = Map::new();
            let v = if value.is_null() {
                &empty
            } else {
                object(value)?
            };
            keys(
                v,
                &["driver", "internal", "external"],
                &field,
                &mut diagnostics,
            );
            if boolean(v.get("external"), false)? {
                diagnostics.push(Diagnostic::error(
                    "external_network",
                    &field,
                    "External/global networks cannot be adopted by candidate enrollment.",
                ));
            }
            let driver = v.get("driver").map(string).transpose()?.unwrap_or("bridge");
            if driver != "bridge" {
                diagnostics.push(Diagnostic::error("unsupported_network_driver",&field,"Only candidate-owned bridge network intent is modeled; execution is still gated."));
            }
            networks.insert(
                name.clone(),
                NetworkPlan {
                    driver: if driver == "bridge" {
                        "bridge".into()
                    } else {
                        "[unsupported]".into()
                    },
                    internal: boolean(v.get("internal"), false)?,
                },
            );
        }
    }
    networks.entry("default".into()).or_insert(NetworkPlan {
        driver: "bridge".into(),
        internal: false,
    });
    let services = service::compile(
        project,
        base,
        object(m.get("services").ok_or_else(|| {
            problem("missing_services", "Compose services mapping is required.")
        })?)?,
        profiles,
        &volumes,
        &mut diagnostics,
    )?;
    graph::validate(&services, &networks, profiles, &mut diagnostics);
    Ok(PlanData {schema_version:1,kind:"compose-enrollment-review-only".into(),candidate_root:candidate.checkout.clone(),source:project.into(),namespace:String::new(),compose_file:file.into(),compose_sha256:format!("{:x}",Sha256::digest(input)),active_profiles:profiles.to_vec(),services,networks,volumes,
        source_selection:SourceSelection {policy:String::new(),identity_kind:String::new(),metadata_sha256:String::new(),ignore_files:BTreeMap::new(),entries:vec![],excluded_paths:vec![],exclusion_rules:vec![]},diagnostics,enrollment_compatible:false,runtime_execution_supported:false,
        planned_effects:vec!["Create one private candidate enrollment receipt only; no project writes, source copy, VM boot, image pull, container, volume, network or port creation".into()],
        execution_gates:vec!["WU04 execution/receipt contract".into(),"WU05 source conformance and sync".into(),"WU07 network/graph/data qualification".into(),"explicit scoped environment delivery and image/build resolution".into()],
    })
}
