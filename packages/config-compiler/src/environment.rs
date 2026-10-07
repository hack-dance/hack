//! Metadata-only environment planning. Managed values, decryption keys and decryption are outside this boundary.
use crate::{
    WorkloadKind, diagnostic_at, json, local,
    model::{EnvironmentValue, Plan},
};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use ts_rs::TS;

fn nullable<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}
#[derive(Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ManagedBindingMetadata {
    pub scope: String,
    pub secret: bool,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EnvMetadata {
    #[ts(type = "1")]
    pub metadata_version: u32,
    #[serde(deserialize_with = "nullable")]
    pub overlay: Option<String>,
    pub overlay_exists: bool,
    pub workloads: BTreeMap<String, BTreeMap<String, ManagedBindingMetadata>>,
    pub inactive_scopes: Vec<String>,
}
/// Projection only; parsing retains strict resolve fields and separately validates metadata.
#[derive(Debug, Serialize, JsonSchema, TS)]
pub struct EnvPlanRequest {
    #[serde(flatten)]
    pub request: local::ResolveRequest,
    pub env_metadata: EnvMetadata,
}
#[derive(Debug, Serialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EnvironmentBinding {
    Managed {
        key: String,
        scope: String,
        secret: bool,
    },
    Literal {
        value: String,
    },
    Default {
        value: String,
    },
}
#[derive(Debug, Serialize, JsonSchema, TS)]
pub struct EnvironmentPlan {
    #[ts(type = "1")]
    pub plan_version: u32,
    pub overlay: Option<String>,
    pub overlay_exists: bool,
    pub complete: bool,
    pub workloads: BTreeMap<String, BTreeMap<String, EnvironmentBinding>>,
    pub warnings: Vec<local::ResolveDiagnostic>,
    pub diagnostics: Vec<local::ResolveDiagnostic>,
}
#[derive(Debug, Serialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum PlanResult {
    Success {
        #[ts(type = "1")]
        transport_version: u32,
        #[ts(type = "true")]
        ok: bool,
        plan: Box<Plan>,
        semantic_hash: String,
        declared_workloads: BTreeMap<String, WorkloadKind>,
        local_resolution: local::LocalResolution,
        environment_plan: EnvironmentPlan,
    },
    Failure {
        #[ts(type = "1")]
        transport_version: u32,
        #[ts(type = "false")]
        ok: bool,
        diagnostics: Vec<local::ResolveDiagnostic>,
    },
}
impl PlanResult {
    pub fn failure(diagnostic: local::ResolveDiagnostic) -> Self {
        Self::Failure {
            transport_version: 1,
            ok: false,
            diagnostics: vec![diagnostic],
        }
    }
    pub fn complete(&self) -> bool {
        matches!(self, Self::Success {environment_plan, ..} if environment_plan.complete)
    }
}
/// Plans symbolic bindings from original documents and effective owner metadata only.
pub fn plan(bytes: &[u8], profiles: &[String]) -> PlanResult {
    match plan_inner(bytes, profiles) {
        Ok((resolved, environment_plan)) => PlanResult::Success {
            transport_version: 1,
            ok: true,
            plan: Box::new(resolved.compiled.plan),
            semantic_hash: resolved.compiled.semantic_hash,
            declared_workloads: resolved.compiled.declared_workloads,
            local_resolution: resolved.local_resolution,
            environment_plan,
        },
        Err(error) => PlanResult::failure(error),
    }
}
fn metadata_error(document: &json::Document, code: &str) -> local::ResolveDiagnostic {
    local::with_role(
        local::DocumentRole::Request,
        diagnostic_at(&document.positions, code, "/env_metadata"),
    )
}
fn read_metadata(document: &mut json::Document) -> Result<EnvMetadata, local::ResolveDiagnostic> {
    crate::shape::object(document, "/env_metadata")
        .map_err(|_| metadata_error(document, "invalid_shape"))?;
    let value = &document.value["env_metadata"];
    if serde_json::to_vec(value)
        .map_err(|_| metadata_error(document, "encoding_failed"))?
        .len()
        > json::MAX_INPUT_BYTES
    {
        return Err(metadata_error(document, "input_too_large"));
    }
    if value
        .get("metadata_version")
        .is_some_and(|v| v.is_u64() && v.as_u64() != Some(1))
    {
        return Err(metadata_error(document, "unsupported_metadata_version"));
    }
    if let Some(workloads) = value
        .get("workloads")
        .and_then(serde_json::Value::as_object)
    {
        for bindings in workloads.values() {
            let Some(bindings) = bindings.as_object() else {
                return Err(metadata_error(document, "invalid_shape"));
            };
            if bindings.values().any(|binding| !binding.is_object()) {
                return Err(metadata_error(document, "invalid_shape"));
            }
        }
    }
    let metadata: EnvMetadata = serde_json::from_value(value.clone())
        .map_err(|_| metadata_error(document, "invalid_metadata"))?;
    // Remove the one additional field; the unchanged resolve decoder rejects every other unknown field.
    if let Some(object) = document.value.as_object_mut() {
        object.remove("env_metadata");
    }
    Ok(metadata)
}
fn valid_scope(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || (i > 0 && matches!(b, b'.' | b'_' | b'-'))
        })
}
fn valid_key(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_uppercase() || b == b'_' || (i > 0 && b.is_ascii_digit()))
}
fn validate_metadata(metadata: &EnvMetadata, resolved: &local::Resolved) -> bool {
    if metadata.overlay != resolved.local_resolution.overlay
        || (metadata.overlay.is_none() && metadata.overlay_exists)
        || metadata
            .workloads
            .keys()
            .ne(resolved.compiled.declared_workloads.keys())
    {
        return false;
    }
    for (name, bindings) in &metadata.workloads {
        if bindings
            .iter()
            .any(|(key, b)| !valid_key(key) || (b.scope != "global" && b.scope != *name))
        {
            return false;
        }
    }
    let mut seen = BTreeSet::new();
    !metadata.inactive_scopes.iter().any(|scope| {
        !valid_scope(scope)
            || matches!(scope.as_str(), "global" | "host")
            || resolved.compiled.declared_workloads.contains_key(scope)
            || !seen.insert(scope)
    })
}
fn plan_inner(
    bytes: &[u8],
    profiles: &[String],
) -> Result<(local::Resolved, EnvironmentPlan), local::ResolveDiagnostic> {
    let mut document = json::parse_with_limit(bytes, local::MAX_REQUEST_BYTES)
        .map_err(|d| local::with_role(local::DocumentRole::Request, d))?;
    let metadata = read_metadata(&mut document)?;
    let metadata_location = diagnostic_at(&document.positions, "invalid_metadata", "/env_metadata");
    let resolved = local::resolve_document(document, profiles)?;
    if !validate_metadata(&metadata, &resolved) {
        return Err(local::with_role(
            local::DocumentRole::Request,
            metadata_location,
        ));
    }
    let output = bind(&resolved, metadata);
    Ok((resolved, output))
}
fn project_diagnostic(
    resolved: &local::Resolved,
    code: &str,
    pointer: &str,
) -> local::ResolveDiagnostic {
    local::with_role(
        local::DocumentRole::Project,
        diagnostic_at(&resolved.compiled.positions, code, pointer),
    )
}
fn managed(key: &str, binding: &ManagedBindingMetadata) -> EnvironmentBinding {
    EnvironmentBinding::Managed {
        key: key.into(),
        scope: binding.scope.clone(),
        secret: binding.secret,
    }
}
fn bind(resolved: &local::Resolved, metadata: EnvMetadata) -> EnvironmentPlan {
    let mut output = EnvironmentPlan {
        plan_version: 1,
        overlay: metadata.overlay.clone(),
        overlay_exists: metadata.overlay_exists,
        complete: true,
        workloads: BTreeMap::new(),
        warnings: Vec::new(),
        diagnostics: Vec::new(),
    };
    if metadata.overlay.is_some() && !metadata.overlay_exists {
        output.warnings.push(resolved.overlay_location.clone());
    }
    if !metadata.inactive_scopes.is_empty() {
        output
            .warnings
            .push(project_diagnostic(resolved, "inactive_env_scope", ""));
    }
    for (kind, workloads) in [
        ("services", &resolved.compiled.plan.services),
        ("jobs", &resolved.compiled.plan.jobs),
    ] {
        for (name, workload) in workloads {
            // Exact metadata namespace equality was established before reaching this loop.
            let Some(baseline) = metadata.workloads.get(name) else {
                continue;
            };
            let mut bindings: BTreeMap<String, EnvironmentBinding> = baseline
                .iter()
                .map(|(key, b)| (key.clone(), managed(key, b)))
                .collect();
            for (dest, directive) in &workload.environment {
                let pointer = json::child(
                    &format!("{}/environment", json::child(&format!("/{kind}"), name)),
                    dest,
                );
                match directive {
                    EnvironmentValue::Literal { literal } => {
                        bindings.insert(
                            dest.clone(),
                            EnvironmentBinding::Literal {
                                value: literal.clone(),
                            },
                        );
                    }
                    EnvironmentValue::Default { default } => {
                        if !baseline.contains_key(dest) {
                            bindings.insert(
                                dest.clone(),
                                EnvironmentBinding::Default {
                                    value: default.clone(),
                                },
                            );
                        }
                    }
                    EnvironmentValue::Unset { .. } => {
                        bindings.remove(dest);
                    }
                    EnvironmentValue::Reference { env_ref } => {
                        if let Some(binding) = baseline.get(env_ref) {
                            if env_ref != dest && baseline.contains_key(dest) {
                                output.diagnostics.push(project_diagnostic(
                                    resolved,
                                    "env_reference_collision",
                                    &pointer,
                                ));
                            } else {
                                bindings.insert(dest.clone(), managed(env_ref, binding));
                            }
                        } else {
                            output.diagnostics.push(project_diagnostic(
                                resolved,
                                "missing_env_reference",
                                &pointer,
                            ));
                        }
                    }
                }
            }
            output.workloads.insert(name.clone(), bindings);
        }
    }
    output.complete = output.diagnostics.is_empty();
    output
}
