//! Container specification identity (HACK-2459, start graph slice S1).
//!
//! The digest names everything Hack asks the engine to create for one service,
//! with the per-run values that change on every attempt replaced by logical
//! names: run-scoped network and volume names, ownership labels, and the
//! boot-bound attachments (probe state, environment lease and launcher paths,
//! relay startup directories), which are added to the compiled config only at
//! create time and are represented here by value-free tokens.
//!
//! Direction of error: a per-run value left in the body only makes two
//! digests differ, which costs a reuse. An input left out could make two
//! different specifications equal, so every compiled field goes in verbatim
//! unless it is listed in [`body`] as replaced.
//!
//! S1 stamps the digest on the created container as [`LABEL`] and checks it
//! on the post-create inspect. No decision reads it yet, and it is not stored
//! in the receipt (older builds refuse unknown receipt fields). The compiled
//! config used by `verify_config` does not carry it, so containers created
//! before this label existed still verify.
use super::{Kind, Resource, probes::Probe};
use crate::{
    CandidateError,
    canonical_digest::{self, CONTAINER_SPEC, Digest},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The engine label that carries a container's specification digest.
pub(super) const LABEL: &str = "io.hack-local.spec";
const OWNERSHIP_PREFIX: &str = "io.hack-local.";

/// Value-free context for one service's digest.
pub(super) struct Context<'a> {
    /// Receipt resources: network and volume names map back to logical keys.
    pub resources: &'a BTreeMap<String, Resource>,
    pub probe: Option<&'a Probe>,
    /// Managed environment or files are delivered through the launcher.
    /// Only the fact is known here; values never reach this module.
    pub managed: bool,
    /// Names of the relay startup bindings selected for this service.
    pub relay: Vec<String>,
    pub amd64_emulation: Option<crate::project::Amd64Emulation>,
}

/// A container's specification identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Spec {
    pub digest: Digest,
    /// False when an input is represented without its full identity yet
    /// (managed delivery before the keyed digest exists, relay bindings by
    /// name only). Reuse must never keep a container whose spec is not
    /// complete; it is recreated instead. Read by the reuse decision (S7).
    #[cfg_attr(not(test), allow(dead_code))]
    pub complete: bool,
}

/// The normalized body of a compiled, not yet attached, container config.
pub(super) fn body(config: &Value, context: &Context<'_>) -> Result<Value, CandidateError> {
    let mut body = config.clone();
    let object = body.as_object_mut().ok_or_else(|| {
        CandidateError::new("graph_spec", "Compiled container config is not an object.")
    })?;
    if let Some(labels) = object.get_mut("Labels").and_then(Value::as_object_mut) {
        labels.retain(|key, _| !key.starts_with(OWNERSHIP_PREFIX));
    }
    let networks: BTreeMap<&str, &str> = names(context.resources, Kind::Network);
    let volumes: BTreeMap<&str, &str> = names(context.resources, Kind::Volume);
    if let Some(host) = object.get_mut("HostConfig").and_then(Value::as_object_mut) {
        if let Some(mode) = host.get_mut("NetworkMode") {
            if let Some(key) = mode.as_str().and_then(|name| networks.get(name)) {
                *mode = json!(format!("network:{key}"));
            }
        }
        if let Some(mounts) = host.get_mut("Mounts").and_then(Value::as_array_mut) {
            for mount in mounts.iter_mut().filter(|m| m["Type"] == "volume") {
                if let Some(key) = mount["Source"].as_str().and_then(|name| volumes.get(name)) {
                    mount["Source"] = json!(format!("volume:{key}"));
                }
            }
        }
    }
    if let Some(endpoints) = object
        .get_mut("NetworkingConfig")
        .and_then(|v| v.get_mut("EndpointsConfig"))
        .and_then(Value::as_object_mut)
    {
        let renamed = std::mem::take(endpoints)
            .into_iter()
            .map(|(name, value)| {
                let name = networks
                    .get(name.as_str())
                    .map_or(name.clone(), |key| format!("network:{key}"));
                (name, value)
            })
            .collect();
        *endpoints = renamed;
    }
    let mut attachments = serde_json::Map::new();
    if let Some(probe) = context.probe {
        // The binary path is its content address; allocation, generation,
        // owner ids and exec state are per run.
        attachments.insert(
            "probe".into(),
            json!({
                "config": probe.config,
                "binary": probe.binary,
                "start_interval_argv": probe.start_interval_argv,
            }),
        );
    }
    if context.managed {
        attachments.insert("managed".into(), json!("unkeyed"));
    }
    if !context.relay.is_empty() {
        let mut relay = context.relay.clone();
        relay.sort();
        attachments.insert("relay".into(), json!(relay));
    }
    if let Some(mode) = context.amd64_emulation {
        attachments.insert("amd64_emulation".into(), json!(mode));
    }
    object.insert("x-hack".into(), Value::Object(attachments));
    Ok(body)
}

/// The specification identity of a compiled, not yet attached, config.
pub(super) fn of(config: &Value, context: &Context<'_>) -> Result<Spec, CandidateError> {
    Ok(Spec {
        digest: canonical_digest::digest(CONTAINER_SPEC, &body(config, context)?)?,
        complete: !context.managed && context.relay.is_empty(),
    })
}

/// The create body: the compiled config plus [`LABEL`]. Only the request
/// carries the label; the compiled config that `verify_config` compares stays
/// label-free, so containers created before the label existed still verify.
pub(super) fn stamped(config: &Value, spec: &Spec) -> Value {
    let mut body = config.clone();
    body["Labels"][LABEL] = json!(spec.digest.to_string());
    body
}

/// The post-create inspect must show the label the create request sent.
pub(super) fn verify_label(inspected: &Value, spec: &Spec) -> Result<(), CandidateError> {
    if inspected["Config"]["Labels"][LABEL].as_str() == Some(spec.digest.to_string().as_str()) {
        return Ok(());
    }
    Err(CandidateError::new(
        "graph_spec_label",
        "Created container does not carry its specification label.",
    ))
}

/// Run-scoped engine names of owned resources of one kind. Cache volumes have
/// content-derived names that are already stable and stay as they are.
fn names(resources: &BTreeMap<String, Resource>, kind: Kind) -> BTreeMap<&str, &str> {
    resources
        .values()
        .filter(|r| r.kind == kind && r.cache.is_none())
        .map(|r| (r.name.as_str(), r.key.as_str()))
        .collect()
}

#[cfg(test)]
#[path = "spec_tests.rs"]
mod tests;
