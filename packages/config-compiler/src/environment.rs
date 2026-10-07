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
    #[serde(
        default,
        deserialize_with = "crate::model::present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "HostMetadata")]
    #[ts(optional, type = "HostMetadata")]
    pub host: Option<HostMetadata>,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct HostMetadata {
    #[serde(
        default,
        deserialize_with = "crate::model::present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "BTreeMap<String,ManagedBindingMetadata>")]
    #[ts(optional, type = "{ [key in string]: ManagedBindingMetadata }")]
    pub default: Option<BTreeMap<String, ManagedBindingMetadata>>,
    pub workloads: BTreeMap<String, BTreeMap<String, ManagedBindingMetadata>>,
}
#[derive(Debug, Serialize, JsonSchema, TS)]
pub struct HostEnvironmentPlan {
    pub env_target: crate::host::HostEnvTarget,
    pub bindings: BTreeMap<String, EnvironmentBinding>,
}
/// Projection only; parsing retains strict resolve fields and separately validates metadata.
#[derive(Debug, Serialize, JsonSchema, TS)]
pub struct EnvPlanRequest {
    #[ts(type = "1")]
    pub request_version: u32,
    pub project: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub primary_local: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub checkout_local: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable,as="Option<String>")]
    pub explicit_overlay: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub global_domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub explicit_domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub branch: Option<String>,
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
    Endpoint {
        reference: crate::endpoint::EndpointReference,
        target: crate::endpoint::EndpointTarget,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "{ [key in string]: HostEnvironmentPlan }")]
    pub host: Option<BTreeMap<String, HostEnvironmentPlan>>,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "HostEnvTargets")]
        host_env_targets: Option<crate::host::HostEnvTargets>,
        local_resolution: local::LocalResolution,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "RoutingResolution")]
        routing_resolution: Option<Box<crate::routing::RoutingResolution>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "HostBindingResolution")]
        host_binding_resolution: Option<Box<crate::endpoint::HostBindingResolution>>,
        environment_plan: Box<EnvironmentPlan>,
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
            host_env_targets: resolved
                .compiled
                .plan
                .host
                .as_ref()
                .map(crate::host::HostConfig::targets),
            plan: Box::new(resolved.compiled.plan),
            semantic_hash: resolved.compiled.semantic_hash,
            declared_workloads: resolved.compiled.declared_workloads,
            local_resolution: resolved.local_resolution,
            routing_resolution: resolved.routing_resolution.map(Box::new),
            host_binding_resolution: resolved.host_binding_resolution.map(Box::new),
            environment_plan: Box::new(environment_plan),
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
    if let Some(host) = value.get("host") {
        let Some(host) = host.as_object() else {
            return Err(metadata_error(document, "invalid_shape"));
        };
        if let Some(default) = host.get("default")
            && !binding_shape(default)
        {
            return Err(metadata_error(document, "invalid_shape"));
        }
        if let Some(workloads) = host.get("workloads").and_then(serde_json::Value::as_object)
            && workloads.values().any(|bindings| !binding_shape(bindings))
        {
            return Err(metadata_error(document, "invalid_shape"));
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
fn binding_shape(value: &serde_json::Value) -> bool {
    value
        .as_object()
        .is_some_and(|bindings| bindings.values().all(serde_json::Value::is_object))
}
fn validate_host_metadata(metadata: &EnvMetadata, resolved: &local::Resolved) -> bool {
    let Some(host) = &resolved.compiled.plan.host else {
        return metadata.host.is_none();
    };
    let Some(metadata) = &metadata.host else {
        return false;
    };
    let targets = host.targets();
    if metadata.default.is_some() != targets.include_default
        || metadata.workloads.keys().ne(targets.workloads.iter())
    {
        return false;
    }
    let generic_host = !resolved.compiled.declared_workloads.contains_key("host");
    let valid = |bindings: &BTreeMap<String, ManagedBindingMetadata>, target: Option<&str>| {
        bindings.iter().all(|(key, b)| {
            valid_key(key)
                && (b.scope == "global"
                    || target == Some(b.scope.as_str())
                    || (generic_host && b.scope == "host"))
        })
    };
    if metadata
        .default
        .as_ref()
        .is_some_and(|bindings| !valid(bindings, None))
    {
        return false;
    }
    metadata
        .workloads
        .iter()
        .all(|(name, bindings)| valid(bindings, Some(name)))
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
    if !validate_host_metadata(metadata, resolved) {
        return false;
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
    if document.value.get("routing_probe").is_some() {
        return Err(local::with_role(
            local::DocumentRole::Request,
            diagnostic_at(&document.positions, "unknown_field", "/routing_probe"),
        ));
    }
    let metadata = read_metadata(&mut document)?;
    let metadata_location = diagnostic_at(&document.positions, "invalid_metadata", "/env_metadata");
    let resolved = local::resolve_document(document, profiles)?;
    if !validate_metadata(&metadata, &resolved) {
        return Err(local::with_role(
            local::DocumentRole::Request,
            metadata_location,
        ));
    }
    let output = bind(&resolved, metadata)?;
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
fn bind(
    resolved: &local::Resolved,
    metadata: EnvMetadata,
) -> Result<EnvironmentPlan, local::ResolveDiagnostic> {
    let mut budget = ReportBudget::new(resolved, &metadata)?;
    let mut output = EnvironmentPlan {
        plan_version: 1,
        overlay: metadata.overlay.clone(),
        overlay_exists: metadata.overlay_exists,
        complete: true,
        workloads: BTreeMap::new(),
        host: None,
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
            let pointer = json::child(&format!("/{kind}"), name);
            budget.value(name, resolved, &pointer)?;
            budget.charge(16, resolved, &pointer)?;
            let bindings = bind_environment(
                resolved,
                baseline,
                &workload.environment,
                &pointer,
                &mut output.diagnostics,
                &mut budget,
                BindingOwner {
                    cache_key: &format!("workload/{name}"),
                    endpoint_context: crate::endpoint::EndpointContext::Workload,
                },
            )?;
            output.workloads.insert(name.clone(), bindings);
        }
    }
    if let (Some(host), Some(host_metadata)) = (&resolved.compiled.plan.host, &metadata.host) {
        let mut plans = BTreeMap::new();
        for entry in host.entries() {
            let baseline = match entry.target {
                crate::host::HostEnvTarget::Host {} => host_metadata.default.as_ref(),
                crate::host::HostEnvTarget::Workload { name } => host_metadata.workloads.get(name),
            };
            if let Some(baseline) = baseline {
                budget.value(entry.name, resolved, &entry.pointer)?;
                budget.value(entry.target, resolved, &entry.pointer)?;
                budget.charge(128, resolved, &entry.pointer)?;
                let cache_key = match entry.target {
                    crate::host::HostEnvTarget::Host {} => "host/default".to_owned(),
                    crate::host::HostEnvTarget::Workload { name } => {
                        format!("host/workload/{name}")
                    }
                };
                let bindings = bind_environment(
                    resolved,
                    baseline,
                    entry.environment,
                    &entry.pointer,
                    &mut output.diagnostics,
                    &mut budget,
                    BindingOwner {
                        cache_key: &cache_key,
                        endpoint_context: crate::endpoint::EndpointContext::Host,
                    },
                )?;
                plans.insert(
                    entry.name.to_owned(),
                    HostEnvironmentPlan {
                        env_target: entry.target.clone(),
                        bindings,
                    },
                );
            }
        }
        output.host = Some(plans);
    }
    output.complete = output.diagnostics.is_empty();
    Ok(output)
}

struct BindingOwner<'a> {
    cache_key: &'a str,
    endpoint_context: crate::endpoint::EndpointContext,
}
fn bind_environment(
    resolved: &local::Resolved,
    baseline: &BTreeMap<String, ManagedBindingMetadata>,
    directives: &BTreeMap<String, EnvironmentValue>,
    pointer: &str,
    diagnostics: &mut Vec<local::ResolveDiagnostic>,
    budget: &mut ReportBudget,
    owner: BindingOwner<'_>,
) -> Result<BTreeMap<String, EnvironmentBinding>, local::ResolveDiagnostic> {
    budget.baseline(owner.cache_key, baseline, resolved, pointer)?;
    let mut bindings: BTreeMap<String, EnvironmentBinding> = baseline
        .iter()
        .map(|(key, b)| (key.clone(), managed(key, b)))
        .collect();
    for (dest, directive) in directives {
        let pointer = json::child(&format!("{pointer}/environment"), dest);
        // Conservatively retain charges for overwritten/unset entries rather than refunding allocation.
        budget.value(dest, resolved, &pointer)?;
        budget.value(directive, resolved, &pointer)?;
        budget.charge(64, resolved, &pointer)?;
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
                        let diagnostic =
                            project_diagnostic(resolved, "env_reference_collision", &pointer);
                        budget.value(&diagnostic, resolved, &pointer)?;
                        diagnostics.push(diagnostic);
                    } else {
                        budget.value(
                            &BorrowedManaged::new(env_ref, binding),
                            resolved,
                            &pointer,
                        )?;
                        bindings.insert(dest.clone(), managed(env_ref, binding));
                    }
                } else {
                    let diagnostic =
                        project_diagnostic(resolved, "missing_env_reference", &pointer);
                    budget.value(&diagnostic, resolved, &pointer)?;
                    diagnostics.push(diagnostic);
                }
            }
            EnvironmentValue::Endpoint { endpoint } => {
                let target = if baseline.contains_key(dest) {
                    Err("env_endpoint_collision")
                } else {
                    crate::endpoint::target(endpoint, owner.endpoint_context, resolved)
                };
                match target {
                    Ok(target) => {
                        budget.value(&target, resolved, &pointer)?;
                        bindings.insert(
                            dest.clone(),
                            EnvironmentBinding::Endpoint {
                                reference: endpoint.clone(),
                                target,
                            },
                        );
                    }
                    Err(code) => {
                        let diagnostic = project_diagnostic(resolved, code, &pointer);
                        budget.value(&diagnostic, resolved, &pointer)?;
                        diagnostics.push(diagnostic);
                    }
                }
            }
        }
    }
    Ok(bindings)
}

/// Shared whole-response safety ceiling, not a process count or runtime resource limit.
pub const MAX_PLAN_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
#[derive(Serialize)]
struct BorrowedManaged<'a> {
    kind: &'static str,
    key: &'a str,
    scope: &'a str,
    secret: bool,
}
impl<'a> BorrowedManaged<'a> {
    fn new(key: &'a str, binding: &'a ManagedBindingMetadata) -> Self {
        Self {
            kind: "managed",
            key,
            scope: &binding.scope,
            secret: binding.secret,
        }
    }
}
struct CountingWriter {
    bytes: usize,
}
impl std::io::Write for CountingWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes = self
            .bytes
            .checked_add(bytes.len())
            .filter(|size| *size <= MAX_PLAN_OUTPUT_BYTES)
            .ok_or_else(|| std::io::Error::other("plan size limit"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub(crate) fn serialized_size(value: &(impl Serialize + ?Sized)) -> Result<usize, ()> {
    let mut counter = CountingWriter { bytes: 0 };
    serde_json::to_writer(&mut counter, value).map_err(|_| ())?;
    Ok(counter.bytes)
}
struct ReportBudget {
    remaining: usize,
    baselines: BTreeMap<String, usize>,
}
impl ReportBudget {
    fn new(
        resolved: &local::Resolved,
        metadata: &EnvMetadata,
    ) -> Result<Self, local::ResolveDiagnostic> {
        let mut result = Self {
            remaining: MAX_PLAN_OUTPUT_BYTES,
            baselines: BTreeMap::new(),
        };
        // Includes fixed envelope/map/array punctuation, warning diagnostics and trailing newline.
        result.charge(4096, resolved, "")?;
        result.value(&resolved.compiled.plan, resolved, "")?;
        result.value(&resolved.compiled.semantic_hash, resolved, "")?;
        result.value(&resolved.compiled.declared_workloads, resolved, "")?;
        result.value(&resolved.local_resolution, resolved, "")?;
        result.value(&resolved.routing_resolution, resolved, "")?;
        result.value(&resolved.host_binding_resolution, resolved, "")?;
        result.value(&metadata.overlay, resolved, "")?;
        if let Some(host) = &resolved.compiled.plan.host {
            result.value(&host.targets(), resolved, "")?;
        }
        Ok(result)
    }
    fn charge(
        &mut self,
        bytes: usize,
        resolved: &local::Resolved,
        pointer: &str,
    ) -> Result<(), local::ResolveDiagnostic> {
        self.remaining = self
            .remaining
            .checked_sub(bytes)
            .ok_or_else(|| project_diagnostic(resolved, "plan_too_large", pointer))?;
        Ok(())
    }
    fn value(
        &mut self,
        value: &(impl Serialize + ?Sized),
        resolved: &local::Resolved,
        pointer: &str,
    ) -> Result<(), local::ResolveDiagnostic> {
        let bytes = serialized_size(value)
            .map_err(|_| project_diagnostic(resolved, "plan_too_large", pointer))?;
        self.charge(bytes, resolved, pointer)
    }
    fn baseline(
        &mut self,
        key: &str,
        baseline: &BTreeMap<String, ManagedBindingMetadata>,
        resolved: &local::Resolved,
        pointer: &str,
    ) -> Result<(), local::ResolveDiagnostic> {
        let bytes = if let Some(bytes) = self.baselines.get(key) {
            *bytes
        } else {
            let mut bytes = 2;
            for (name, binding) in baseline {
                bytes += serialized_size(name)
                    .and_then(|name_size| {
                        serialized_size(&BorrowedManaged::new(name, binding))
                            .map(|binding_size| name_size + binding_size + 2)
                    })
                    .map_err(|_| project_diagnostic(resolved, "plan_too_large", pointer))?;
                if bytes > MAX_PLAN_OUTPUT_BYTES {
                    return Err(project_diagnostic(resolved, "plan_too_large", pointer));
                }
            }
            self.baselines.insert(key.to_owned(), bytes);
            bytes
        };
        self.charge(bytes, resolved, pointer)
    }
}
