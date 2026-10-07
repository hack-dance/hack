//! Pure, bounded native configuration compiler. It performs no host admission or secret lookup.
pub mod endpoint;
pub mod environment;
pub mod host;
mod json;
pub mod local;
pub mod model;
pub mod routing;
mod shape;
mod validate;
pub use json::MAX_INPUT_BYTES;
use model::{Plan, Project};
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, JsonSchema, TS)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub pointer: String,
    pub line: usize,
    pub column: usize,
}
impl Diagnostic {
    pub fn new(code: &str, pointer: &str, line: usize, column: usize) -> Self {
        Self {
            code: code.into(),
            message: diagnostic_message(code).into(),
            pointer: pointer.into(),
            line,
            column,
        }
    }
}
fn diagnostic_message(code: &str) -> &'static str {
    match code {
        "unsupported_metadata_version" => "The environment metadata version is not supported.",
        "invalid_metadata" => {
            "Environment metadata does not match the declared workload selection."
        }
        "missing_env_reference" => "A required managed environment reference is missing.",
        "env_reference_collision" => {
            "A remapped reference conflicts with an existing managed destination."
        }
        "env_endpoint_collision" => "An endpoint cannot replace an existing managed destination.",
        "unsupported_endpoint_context" => {
            "A direct service endpoint has no qualified host address."
        }
        "unknown_endpoint_target" => "The endpoint must name a declared route or service.",
        "inactive_endpoint_target" => {
            "An active invocation references a disabled service endpoint."
        }
        "unknown_host_binding" => {
            "The logical host binding is absent from the effective local selection."
        }
        "removed_host_binding" => "The local selection removes a referenced logical host binding.",
        "invalid_host_binding" => {
            "Use a canonical hostname and explicit nonzero port and protocol."
        }
        "invalid_endpoint" => "Use a canonical reference name and explicit nonzero service port.",
        "missing_overlay" => {
            "The selected overlay is missing; available base and local layers are used."
        }
        "inactive_env_scope" => {
            "Stored environment scopes outside the declared workload namespace are inactive."
        }
        "unsupported_request_version" => "The resolution request version is not supported.",
        "plan_too_large" => "The expanded plan exceeds the compiler output safety limit.",
        "input_too_large" => "Configuration exceeds the compiler input byte limit.",
        "invalid_utf8" => "Configuration must be UTF-8.",
        "invalid_json" => "Configuration is not a complete valid JSON document.",
        "depth_limit" => "Configuration exceeds the compiler nesting limit.",
        "duplicate_key" => "Duplicate JSON object keys are not allowed.",
        "unsupported_version" => "The authored schema version is not supported.",
        "unknown_field" => "This field is not supported by this compiler.",
        "invalid_shape" => "The value does not match the supported configuration shape.",
        "invalid_name" => "Use a unique canonical name within the declared namespace.",
        "invalid_path" => "The path must use the required portable relative or absolute form.",
        "unknown_env_target" => "The host environment target must name a declared workload.",
        "invalid_singleton" => "Singleton ports must be distinct nonzero ports.",
        "invalid_domain" => "Use canonical DNS labels without wildcards or trailing dots.",
        "invalid_origin" => "Use an HTTP origin without credentials, path, query or fragment.",
        "invalid_route" => "The route requires a valid service port and hostname.",
        "unknown_route_service" => "The route must target a declared service.",
        "unknown_route_alias" => "The selected OAuth alias must be declared.",
        "route_collision" => "Declared routes or aliases resolve to the same origin.",
        "missing_open_alias" => {
            "Alias open preference requires an explicitly selected OAuth alias."
        }
        "unknown_profile" => "The profile must be declared by the project.",
        "duplicate_workload" => "Services and jobs must have distinct names.",
        "unknown_dependency" => {
            "The dependency must reference a declared target of the correct kind."
        }
        "missing_readiness" => "A ready dependency requires an explicit readiness check.",
        "inactive_dependency" => "An active workload depends on a disabled profile target.",
        "dependency_cycle" => "The workload dependency graph contains a cycle.",
        "image_build_exclusive" => "Specify exactly one image or build definition.",
        "invalid_image" => "The image reference must be nonempty and contain no whitespace.",
        "invalid_command" => {
            "Use a nonempty exec argument list or explicit shell command without NUL bytes."
        }
        "invalid_environment_key" => "Use a valid environment variable name.",
        "invalid_environment_value" => "Environment values cannot contain NUL bytes.",
        "unknown_storage" => "The mount must reference declared storage.",
        "duplicate_mount_target" => "Mount targets must be unique after path normalization.",
        "duplicate_dependency" => "Each dependency target may be declared only once.",
        "invalid_readiness" => "The readiness check requires valid port, path and retry settings.",
        "invalid_duration" => {
            "Use a positive integer duration in ms, s, m or h within the supported millisecond range."
        }
        "input_read_failed" => "Configuration input could not be read.",
        _ => "Configuration could not be compiled.",
    }
}

#[derive(Debug, Serialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum CompileResult {
    Success {
        #[ts(type = "1")]
        transport_version: u32,
        #[ts(type = "true")]
        ok: bool,
        plan: Box<Plan>,
        declared_workloads: BTreeMap<String, WorkloadKind>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "HostEnvTargets")]
        host_env_targets: Option<host::HostEnvTargets>,
        semantic_hash: String,
    },
    Failure {
        #[ts(type = "1")]
        transport_version: u32,
        #[ts(type = "false")]
        ok: bool,
        diagnostics: Vec<Diagnostic>,
    },
}
impl CompileResult {
    pub fn failure(diagnostic: Diagnostic) -> Self {
        Self::Failure {
            transport_version: 1,
            ok: false,
            diagnostics: vec![diagnostic],
        }
    }
}

/// Compiles explicit input and profile names only. Environment directives stay symbolic.
pub fn compile(bytes: &[u8], profiles: &[String]) -> CompileResult {
    match compile_inner(bytes, profiles) {
        Ok(compiled) => CompileResult::Success {
            transport_version: 1,
            ok: true,
            host_env_targets: compiled.plan.host.as_ref().map(host::HostConfig::targets),
            plan: Box::new(compiled.plan),
            declared_workloads: compiled.declared_workloads,
            semantic_hash: compiled.semantic_hash,
        },
        Err(error) => CompileResult::failure(error),
    }
}
#[derive(Debug, Clone, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorkloadKind {
    Service,
    Job,
}
struct Compiled {
    plan: Plan,
    semantic_hash: String,
    declared_workloads: BTreeMap<String, WorkloadKind>,
    positions: BTreeMap<String, (usize, usize)>,
    endpoint_uses: Vec<endpoint::EndpointUse>,
}
fn compile_inner(bytes: &[u8], profiles: &[String]) -> Result<Compiled, Diagnostic> {
    let document = json::parse(bytes)?;
    let at = |code: &str, pointer: &str| diagnostic_at(&document.positions, code, pointer);
    if let Some(version) = document.value.get("schema_version")
        && version.is_u64()
        && version.as_u64() != Some(1)
    {
        return Err(at("unsupported_version", "/schema_version"));
    }
    shape::project(&document)?;
    let project: Project =
        serde_path_to_error::deserialize(document.value.clone()).map_err(|error| {
            let mut pointer = String::new();
            for segment in error.path().iter() {
                match segment {
                    serde_path_to_error::Segment::Seq { index } => {
                        pointer = json::child(&pointer, &index.to_string())
                    }
                    serde_path_to_error::Segment::Map { key }
                    | serde_path_to_error::Segment::Enum { variant: key } => {
                        pointer = json::child(&pointer, key)
                    }
                    _ => {}
                }
            }
            // Serde error text may contain authored values. Classify it but never return it.
            let code = if error.inner().to_string().starts_with("unknown field") {
                "unknown_field"
            } else {
                "invalid_shape"
            };
            at(code, &pointer)
        })?;
    let declared_workloads = project
        .services
        .keys()
        .map(|name| (name.clone(), WorkloadKind::Service))
        .chain(
            project
                .jobs
                .keys()
                .map(|name| (name.clone(), WorkloadKind::Job)),
        )
        .collect();
    let endpoint_uses = endpoint::uses(&project);
    let plan = validate::lower(project, profiles, &at)?;
    let encoded = serde_json::to_vec(&plan).map_err(|_| at("encoding_failed", ""))?;
    let semantic_hash = format!("{:x}", Sha256::digest(encoded));
    Ok(Compiled {
        plan,
        semantic_hash,
        declared_workloads,
        positions: document.positions,
        endpoint_uses,
    })
}
fn diagnostic_at(
    positions: &BTreeMap<String, (usize, usize)>,
    code: &str,
    pointer: &str,
) -> Diagnostic {
    let mut location = pointer;
    let position = loop {
        if let Some(position) = positions.get(location) {
            break *position;
        }
        match location.rsplit_once('/') {
            Some((parent, _)) => location = parent,
            None => break (1, 1),
        }
    };
    Diagnostic::new(code, pointer, position.0, position.1)
}

/// Generates bundled schema and TypeScript projections of the Rust wire types.
pub fn artifacts() -> Result<(String, String), serde_json::Error> {
    use model::*;
    let mut schema = serde_json::to_value(schemars::schema_for!(Project))?;
    // Cross-field choice enforced by lower() and independently exercised in the schema corpus.
    schema["$defs"]["Workload"]["oneOf"] = serde_json::json!([
        {"required":["image"], "not":{"required":["build"]}},
        {"required":["build"], "not":{"required":["image"]}}
    ]);
    schema["$defs"]["HostSingleton"]["properties"]["ports"]["items"]["minimum"] =
        serde_json::json!(1);
    schema["properties"]["host_bindings"]["propertyNames"] = endpoint::binding_name_schema();
    let schema = serde_json::to_string_pretty(&schema)? + "\n";
    let cfg = ts_rs::Config::default();
    let declarations = [
        environment::ManagedBindingMetadata::decl(&cfg),
        environment::EnvMetadata::decl(&cfg),
        environment::HostMetadata::decl(&cfg),
        environment::HostEnvironmentPlan::decl(&cfg),
        environment::EnvPlanRequest::decl(&cfg),
        environment::EnvironmentBinding::decl(&cfg),
        endpoint::EndpointProtocol::decl(&cfg),
        endpoint::EndpointReference::decl(&cfg),
        endpoint::HostBindingTarget::decl(&cfg),
        endpoint::HostBindingOrigin::decl(&cfg),
        endpoint::ResolvedHostBinding::decl(&cfg),
        endpoint::HostBindingResolution::decl(&cfg),
        endpoint::EndpointContext::decl(&cfg),
        endpoint::EndpointTarget::decl(&cfg),
        environment::EnvironmentPlan::decl(&cfg),
        environment::PlanResult::decl(&cfg),
        host::HostConfig::decl(&cfg),
        host::HostHooks::decl(&cfg),
        host::HostHook::decl(&cfg),
        host::HostProcess::decl(&cfg),
        host::HostEnvTarget::decl(&cfg),
        host::HostStartup::decl(&cfg),
        host::HostExit::decl(&cfg),
        host::HostSingleton::decl(&cfg),
        host::HostConflict::decl(&cfg),
        host::HostEnvTargets::decl(&cfg),
        routing::Routes::decl(&cfg),
        routing::RouteAlias::decl(&cfg),
        routing::HttpRoute::decl(&cfg),
        routing::HttpProtocol::decl(&cfg),
        routing::OpenConfig::decl(&cfg),
        routing::OpenPreference::decl(&cfg),
        routing::LocalRoutes::decl(&cfg),
        routing::LocalOpen::decl(&cfg),
        routing::DomainOrigin::decl(&cfg),
        routing::OpenPreferenceOrigin::decl(&cfg),
        routing::ResolvedHttpRoute::decl(&cfg),
        routing::RoutingResolution::decl(&cfg),
        WorktreePolicy::decl(&cfg),
        SourceMode::decl(&cfg),
        Source::decl(&cfg),
        EnvironmentSelection::decl(&cfg),
        Build::decl(&cfg),
        Command::decl(&cfg),
        True::decl(&cfg),
        EnvironmentValue::decl(&cfg),
        StorageKind::decl(&cfg),
        StorageScope::decl(&cfg),
        Storage::decl(&cfg),
        Access::decl(&cfg),
        Mount::decl(&cfg),
        ServiceCondition::decl(&cfg),
        JobCondition::decl(&cfg),
        Dependency::decl(&cfg),
        Readiness::decl(&cfg),
        Workload::decl(&cfg),
        Project::decl(&cfg),
        Plan::decl(&cfg),
        Diagnostic::decl(&cfg),
        WorkloadKind::decl(&cfg),
        CompileResult::decl(&cfg),
        local::LocalEnvironment::decl(&cfg),
        local::LocalConfig::decl(&cfg),
        local::ResolveRequest::decl(&cfg),
        local::DocumentRole::decl(&cfg),
        local::ResolveDiagnostic::decl(&cfg),
        local::OverlayOrigin::decl(&cfg),
        local::LocalResolution::decl(&cfg),
        local::ResolveResult::decl(&cfg),
    ];
    Ok((
        schema,
        format!(
            "// Generated by hack-config-compiler; do not edit.\n{}\n",
            declarations
                .iter()
                .map(|d| format!("export {d}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
    ))
}

pub fn protocol() -> Value {
    serde_json::json!({"transport_version":1,"authored_version":1,"plan_version":1,"resolve_version":1,"local_version":1,"env_plan_version":1,"host_env_plan_version":1,"routing_plan_version":1,"endpoint_plan_version":1})
}
