//! Reviewed dependency selection. No credential is a configuration field.
use hack_runtime_core::{
    Candidate, CandidateError,
    provider::{graph, host_endpoint::HostEndpoint},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

fn refused() -> CandidateError {
    CandidateError::new(
        "graph_dependencies",
        "Dependency selection is invalid, changed, or no longer bound to its reviewed host listeners.",
    )
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    version: u8,
    plan: String,
    artifact: PathBuf,
    artifact_sha256: String,
    dependencies: Vec<Binding>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    service: String,
    binding: String,
    slot: u8,
    guest_port: u16,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    aliases: Vec<String>,
    host_pid: i32,
    host_port: u16,
}
fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}
fn service_name(value: &str) -> bool {
    value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
impl Selection {
    fn parse(bytes: &[u8]) -> Result<Self, CandidateError> {
        if bytes.len() > 65536 {
            return Err(refused());
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| refused())?;
        let mut keys = BTreeSet::new();
        let mut slots = BTreeMap::new();
        let mut service_slots = BTreeSet::new();
        let mut ports = BTreeSet::new();
        let mut aliases = BTreeSet::new();
        if value.version != 1
            || !hex(&value.plan)
            || !hex(&value.artifact_sha256)
            || !value.artifact.is_absolute()
            || value.dependencies.len()
                > hack_runtime_core::provider::relay_auth::MAX_LOGICAL_BINDINGS
            || !value.dependencies.iter().all(|b| {
                service_name(&b.service)
                    && name(&b.binding)
                    && b.slot < 32
                    && b.guest_port > 0
                    && b.host_pid > 1
                    && b.host_port > 0
                    && keys.insert((&b.service, &b.binding))
                    && slots
                        .insert(b.slot, (b.host_pid, b.host_port))
                        .is_none_or(|prior| prior == (b.host_pid, b.host_port))
                    && service_slots.insert((&b.service, b.slot))
                    && graph::dependency_address(b.slot, &b.aliases).is_ok()
                    && ports.insert((
                        &b.service,
                        graph::dependency_address(b.slot, &b.aliases).ok(),
                        b.guest_port,
                    ))
                    && b.aliases
                        .iter()
                        .all(|name| aliases.insert((&b.service, name)))
            })
        {
            return Err(refused());
        }
        Ok(value)
    }
    fn read(path: &Path) -> Result<Self, CandidateError> {
        let mut file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| refused())?;
        let before = file.metadata().map_err(|_| refused())?;
        if !before.is_file() || before.nlink() != 1 || before.len() > 65536 {
            return Err(refused());
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take(65537)
            .read_to_end(&mut bytes)
            .map_err(|_| refused())?;
        if bytes.len() as u64 != before.len() {
            return Err(refused());
        }
        Self::parse(&bytes)
    }
    fn capture(&self) -> Result<(String, Vec<graph::Dependency>), CandidateError> {
        let mut evidence = Vec::new();
        let mut dependencies = Vec::new();
        let mut slots = BTreeMap::new();
        for binding in &self.dependencies {
            let endpoint = HostEndpoint::capture(binding.host_pid, binding.host_port)?;
            let fingerprint = endpoint.fingerprint()?;
            if slots
                .insert(binding.slot, fingerprint.clone())
                .is_some_and(|prior| prior != fingerprint)
            {
                return Err(refused());
            }
            evidence.push(fingerprint);
            dependencies.push(graph::Dependency {
                service: binding.service.clone(),
                binding: binding.binding.clone(),
                slot: binding.slot,
                port: binding.guest_port,
                aliases: binding.aliases.clone(),
                endpoint,
            });
        }
        let bytes = serde_json::to_vec(&("hack-graph-dependencies-v1", self, evidence))
            .map_err(|_| refused())?;
        Ok((format!("{:x}", Sha256::digest(bytes)), dependencies))
    }
}
pub(super) fn plan(path: &Path) -> Result<Value, CandidateError> {
    let selection = Selection::read(path)?;
    let (digest, _) = selection.capture()?;
    Ok(
        json!({"version":1,"plan_id":selection.plan,"dependency_plan_id":digest,"selection":selection}),
    )
}
pub(super) fn runtime(
    candidate: &Candidate,
    path: &Path,
    plan: &str,
    expected: &str,
    inputs: &hack_runtime_core::project::inputs::ExecutionInputs,
    run: &str,
) -> Result<graph::HostRelayRuntime, CandidateError> {
    let selection = Selection::read(path)?;
    if selection.plan != plan || !hex(expected) {
        return Err(refused());
    }
    let (digest, dependencies) = selection.capture()?;
    if digest != expected {
        return Err(refused());
    }
    graph::HostRelayRuntime::validate_inputs(&dependencies, inputs)?;
    graph::HostRelayRuntime::new_for_run(
        candidate,
        &selection.artifact,
        &selection.artifact_sha256,
        dependencies,
        run,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    fn value() -> Value {
        json!({"version":1,"plan":"a".repeat(64),"artifact":"/reviewed/guest","artifact_sha256":"b".repeat(64),"dependencies":[{"service":"web","binding":"database","slot":0,"guest_port":5432,"host_pid":42,"host_port":15432},{"service":"web","binding":"search","slot":1,"guest_port":9200,"host_pid":43,"host_port":19200}]})
    }
    #[test]
    fn explicit_empty_selection_still_binds_plan_and_artifact_metadata() {
        let mut document = value();
        document["dependencies"] = json!([]);
        let selection = Selection::parse(&serde_json::to_vec(&document).unwrap()).unwrap();
        let (digest, bindings) = selection.capture().unwrap();
        assert!(bindings.is_empty());
        document["plan"] = json!("c".repeat(64));
        let changed = Selection::parse(&serde_json::to_vec(&document).unwrap()).unwrap();
        assert_ne!(digest, changed.capture().unwrap().0);
        document.as_object_mut().unwrap().remove("dependencies");
        assert!(Selection::parse(&serde_json::to_vec(&document).unwrap()).is_err());
    }
    #[test]
    fn named_bindings_allow_multiple_dependencies_but_refuse_collisions() {
        let good = value();
        assert!(Selection::parse(&serde_json::to_vec(&good).unwrap()).is_ok());
        let mut upper = good.clone();
        for binding in upper["dependencies"].as_array_mut().unwrap() {
            binding["service"] = json!("Web");
        }
        assert!(Selection::parse(&serde_json::to_vec(&upper).unwrap()).is_ok());
        for key in ["binding", "slot", "guest_port"] {
            let mut bad = good.clone();
            bad["dependencies"][1][key] = bad["dependencies"][0][key].clone();
            assert!(
                Selection::parse(&serde_json::to_vec(&bad).unwrap()).is_err(),
                "{key}"
            );
        }
    }
    #[test]
    fn same_port_requires_distinct_exact_alias_bindings() {
        let mut named = value();
        named["dependencies"][0]["guest_port"] = json!(443);
        named["dependencies"][1]["guest_port"] = json!(443);
        named["dependencies"][0]["aliases"] = json!(["one.example"]);
        named["dependencies"][1]["aliases"] = json!(["two.example"]);
        assert!(Selection::parse(&serde_json::to_vec(&named).unwrap()).is_ok());
        for aliases in [
            json!(["one.example"]),
            json!(["*.example"]),
            json!(["127.0.0.2"]),
        ] {
            let mut bad = named.clone();
            bad["dependencies"][1]["aliases"] = aliases;
            assert!(Selection::parse(&serde_json::to_vec(&bad).unwrap()).is_err());
        }
    }
    #[test]
    fn untrusted_unknown_fields_and_invalid_targets_refuse() {
        for (key, field_value) in [
            ("host_pid", json!(1)),
            ("guest_port", json!(0)),
            ("slot", json!(32)),
            ("binding", json!("search/other")),
            ("credential", json!("not-accepted")),
        ] {
            let mut bad = value();
            bad["dependencies"][0][key] = field_value;
            assert!(
                Selection::parse(&serde_json::to_vec(&bad).unwrap()).is_err(),
                "{key}"
            );
        }
        let mut bad = value();
        bad["version"] = json!(2);
        assert!(Selection::parse(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
    #[test]
    fn review_digest_binds_configuration_and_live_listener_generation() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut document = value();
        document["dependencies"].as_array_mut().unwrap().truncate(1);
        document["dependencies"][0]["host_pid"] = json!(std::process::id());
        document["dependencies"][0]["host_port"] = json!(address.port());
        let mut shared = document["dependencies"][0].clone();
        shared["service"] = json!("worker");
        document["dependencies"]
            .as_array_mut()
            .unwrap()
            .push(shared);
        let selection = Selection::parse(&serde_json::to_vec(&document).unwrap()).unwrap();
        let (before, bindings) = selection.capture().unwrap();
        assert_eq!(bindings.len(), 2);
        assert_eq!(
            bindings[0].endpoint.fingerprint().unwrap(),
            bindings[1].endpoint.fingerprint().unwrap()
        );
        assert_eq!(before, selection.capture().unwrap().0);
        document["dependencies"][0]["binding"] = json!("other");
        let changed = Selection::parse(&serde_json::to_vec(&document).unwrap()).unwrap();
        assert_ne!(before, changed.capture().unwrap().0);
        document["dependencies"][0]["binding"] = json!("database");
        document["dependencies"][0]["aliases"] = json!(["one.example"]);
        let named = Selection::parse(&serde_json::to_vec(&document).unwrap()).unwrap();
        assert_ne!(before, named.capture().unwrap().0);
        drop(listener);
        let replacement = TcpListener::bind(address).unwrap();
        assert_ne!(before, selection.capture().unwrap().0);
        drop(replacement);
    }
    #[test]
    fn shared_listener_selection_accepts_72_bindings_but_not_foreign_endpoints() {
        let mut document = value();
        document["dependencies"] = json!(
            (0..12)
                .flat_map(|service| (0..6).map(move |slot| json!({
                    "service":format!("service-{service}"), "binding":format!("binding-{slot}"),
                    "slot":slot, "guest_port":9000+slot, "host_pid":42, "host_port":19000+slot,
                    "aliases":[format!("dependency-{slot}.example")]
                })))
                .collect::<Vec<_>>()
        );
        assert!(Selection::parse(&serde_json::to_vec(&document).unwrap()).is_ok());
        for (field, value) in [
            ("host_pid", json!(43)),
            ("host_port", json!(25000)),
            ("slot", json!(32)),
        ] {
            let mut bad = document.clone();
            bad["dependencies"][71][field] = value;
            assert!(Selection::parse(&serde_json::to_vec(&bad).unwrap()).is_err());
        }
        let mut duplicate = document.clone();
        duplicate["dependencies"][71] = duplicate["dependencies"][70].clone();
        assert!(Selection::parse(&serde_json::to_vec(&duplicate).unwrap()).is_err());
        let first = document["dependencies"][0].clone();
        while document["dependencies"].as_array().unwrap().len() <= 128 {
            document["dependencies"]
                .as_array_mut()
                .unwrap()
                .push(first.clone());
        }
        assert!(Selection::parse(&serde_json::to_vec(&document).unwrap()).is_err());
    }
}
