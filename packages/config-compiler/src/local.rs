//! Pure local input resolution. Callers acquire verified documents; no paths or secrets enter here.
use crate::{Diagnostic, compile_inner, diagnostic_at, json, model::Plan, validate::overlay_name};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

pub const MAX_REQUEST_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_DOCUMENT_BYTES: usize = 3 * json::MAX_INPUT_BYTES;

fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
fn overlay<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct LocalEnvironment {
    #[serde(
        default,
        deserialize_with = "overlay",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<String>", regex(pattern = "^[a-z0-9]+(?:-[a-z0-9]+)*$"))]
    #[ts(optional = nullable, as = "Option<String>")]
    pub default_overlay: Option<Option<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct LocalConfig {
    #[schemars(range(min = 1, max = 1))]
    #[ts(type = "1")]
    pub schema_version: u32,
    #[serde(default)]
    #[ts(optional, as = "Option<LocalEnvironment>")]
    pub environment: LocalEnvironment,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "crate::routing::LocalRoutes")]
    #[ts(optional, type = "LocalRoutes")]
    pub routes: Option<crate::routing::LocalRoutes>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "crate::routing::LocalOpen")]
    #[ts(optional, type = "LocalOpen")]
    pub open: Option<crate::routing::LocalOpen>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ResolveRequest {
    #[schemars(range(min = 1, max = 1))]
    #[ts(type = "1")]
    pub request_version: u32,
    pub project: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    #[ts(optional, type = "string")]
    pub primary_local: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    #[ts(optional, type = "string")]
    pub checkout_local: Option<String>,
    #[serde(
        default,
        deserialize_with = "overlay",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<String>", regex(pattern = "^[a-z0-9]+(?:-[a-z0-9]+)*$"))]
    #[ts(optional = nullable, as = "Option<String>")]
    pub explicit_overlay: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    #[ts(optional, type = "string")]
    pub global_domain: Option<String>,

    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    #[ts(optional, type = "string")]
    pub explicit_domain: Option<String>,

    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    #[ts(optional, type = "string")]
    pub branch: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    #[ts(optional, type = "boolean")]
    pub routing_probe: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum DocumentRole {
    Project,
    PrimaryLocal,
    CheckoutLocal,
    Request,
}
#[derive(Debug, Clone, Serialize, JsonSchema, TS)]
pub struct ResolveDiagnostic {
    pub document: DocumentRole,
    #[serde(flatten)]
    pub diagnostic: Diagnostic,
}
#[derive(Debug, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum OverlayOrigin {
    Project,
    PrimaryLocal,
    CheckoutLocal,
    Explicit,
}
#[derive(Debug, Serialize, JsonSchema, TS)]
pub struct LocalResolution {
    pub overlay: Option<String>,
    pub origin: OverlayOrigin,
    pub auto_branch: bool,
    pub inherit_local: bool,
    pub resolution_hash: String,
}
#[derive(Debug, Serialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum ResolveResult {
    Success {
        #[ts(type = "1")]
        transport_version: u32,
        #[ts(type = "true")]
        ok: bool,
        plan: Box<Plan>,
        semantic_hash: String,
        declared_workloads: std::collections::BTreeMap<String, crate::WorkloadKind>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "HostEnvTargets")]
        host_env_targets: Option<crate::host::HostEnvTargets>,
        local_resolution: LocalResolution,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "RoutingResolution")]
        routing_resolution: Option<Box<crate::routing::RoutingResolution>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "true")]
        routing_inputs_required: Option<bool>,
    },
    Failure {
        #[ts(type = "1")]
        transport_version: u32,
        #[ts(type = "false")]
        ok: bool,
        diagnostics: Vec<ResolveDiagnostic>,
    },
}
impl ResolveResult {
    pub fn failure(document: DocumentRole, diagnostic: Diagnostic) -> Self {
        Self::Failure {
            transport_version: 1,
            ok: false,
            diagnostics: vec![ResolveDiagnostic {
                document,
                diagnostic,
            }],
        }
    }
}
pub(crate) fn with_role(document: DocumentRole, diagnostic: Diagnostic) -> ResolveDiagnostic {
    ResolveDiagnostic {
        document,
        diagnostic,
    }
}
pub(crate) fn decode<T: serde::de::DeserializeOwned>(
    document: &json::Document,
    role: DocumentRole,
) -> Result<T, ResolveDiagnostic> {
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
        let code = if error.inner().to_string().starts_with("unknown field") {
            "unknown_field"
        } else {
            "invalid_shape"
        };
        with_role(role, diagnostic_at(&document.positions, code, &pointer))
    })
}
pub(crate) struct ParsedLocal {
    pub(crate) config: LocalConfig,
    overlay_location: ResolveDiagnostic,
    pub(crate) positions: std::collections::BTreeMap<String, (usize, usize)>,
}
fn read_local(text: &str, role: DocumentRole) -> Result<ParsedLocal, ResolveDiagnostic> {
    let document = json::parse(text.as_bytes()).map_err(|d| with_role(role, d))?;
    if document
        .value
        .get("schema_version")
        .is_some_and(|v| v.is_u64() && v.as_u64() != Some(1))
    {
        return Err(with_role(
            role,
            diagnostic_at(
                &document.positions,
                "unsupported_version",
                "/schema_version",
            ),
        ));
    }
    crate::shape::object(&document, "").map_err(|d| with_role(role, d))?;
    if document.value.get("environment").is_some() {
        crate::shape::object(&document, "/environment").map_err(|d| with_role(role, d))?;
    }
    for key in ["routes", "open"] {
        if document.value.get(key).is_some() {
            crate::shape::object(&document, &format!("/{key}")).map_err(|d| with_role(role, d))?;
        }
    }
    let local: LocalConfig = decode(&document, role)?;
    if local
        .routes
        .as_ref()
        .and_then(|routes| routes.domain.as_ref())
        .is_some_and(|domain| !crate::routing::domain(domain))
    {
        return Err(with_role(
            role,
            diagnostic_at(&document.positions, "invalid_domain", "/routes/domain"),
        ));
    }
    if local
        .environment
        .default_overlay
        .as_ref()
        .and_then(|v| v.as_ref())
        .is_some_and(|name| !overlay_name(name))
    {
        return Err(with_role(
            role,
            diagnostic_at(
                &document.positions,
                "invalid_name",
                "/environment/default_overlay",
            ),
        ));
    }
    Ok(ParsedLocal {
        config: local,
        overlay_location: with_role(
            role,
            diagnostic_at(
                &document.positions,
                "missing_overlay",
                "/environment/default_overlay",
            ),
        ),
        positions: document.positions,
    })
}

/// Resolve only the explicitly supplied original documents. No discovery, acquisition or decryption.
pub fn resolve(bytes: &[u8], profiles: &[String]) -> ResolveResult {
    match resolve_inner(bytes, profiles) {
        Ok(resolved) => ResolveResult::Success {
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
            routing_inputs_required: resolved.routing_inputs_required,
        },
        Err(diagnostic) => ResolveResult::Failure {
            transport_version: 1,
            ok: false,
            diagnostics: vec![diagnostic],
        },
    }
}
pub(crate) struct Resolved {
    pub(crate) compiled: crate::Compiled,
    pub(crate) local_resolution: LocalResolution,
    pub(crate) overlay_location: ResolveDiagnostic,
    pub(crate) routing_resolution: Option<crate::routing::RoutingResolution>,
    pub(crate) routing_inputs_required: Option<bool>,
}
fn resolve_inner(bytes: &[u8], profiles: &[String]) -> Result<Resolved, ResolveDiagnostic> {
    let document = json::parse_with_limit(bytes, MAX_REQUEST_BYTES)
        .map_err(|d| with_role(DocumentRole::Request, d))?;
    resolve_document(document, profiles)
}
pub(crate) fn resolve_document(
    document: json::Document,
    profiles: &[String],
) -> Result<Resolved, ResolveDiagnostic> {
    if document
        .value
        .get("request_version")
        .is_some_and(|v| v.is_u64() && v.as_u64() != Some(1))
    {
        return Err(with_role(
            DocumentRole::Request,
            diagnostic_at(
                &document.positions,
                "unsupported_request_version",
                "/request_version",
            ),
        ));
    }
    crate::shape::object(&document, "").map_err(|d| with_role(DocumentRole::Request, d))?;
    let request: ResolveRequest = decode(&document, DocumentRole::Request)?;
    for (pointer, value) in [
        ("/global_domain", &request.global_domain),
        ("/explicit_domain", &request.explicit_domain),
    ] {
        if value
            .as_ref()
            .is_some_and(|domain| !crate::routing::domain(domain))
        {
            return Err(with_role(
                DocumentRole::Request,
                diagnostic_at(&document.positions, "invalid_domain", pointer),
            ));
        }
    }
    if request
        .branch
        .as_ref()
        .is_some_and(|branch| !crate::routing::label(branch))
    {
        return Err(with_role(
            DocumentRole::Request,
            diagnostic_at(&document.positions, "invalid_name", "/branch"),
        ));
    }
    let documents = [
        (DocumentRole::Project, Some(request.project.as_str())),
        (DocumentRole::PrimaryLocal, request.primary_local.as_deref()),
        (
            DocumentRole::CheckoutLocal,
            request.checkout_local.as_deref(),
        ),
    ];
    let mut total = 0;
    for (role, text) in documents {
        if let Some(text) = text {
            if text.len() > json::MAX_INPUT_BYTES {
                return Err(with_role(
                    role,
                    Diagnostic::new("input_too_large", "", 1, 1),
                ));
            }
            total += text.len();
        }
    }
    if total > MAX_DOCUMENT_BYTES {
        return Err(with_role(
            DocumentRole::Request,
            Diagnostic::new("input_too_large", "", 1, 1),
        ));
    }
    if request
        .explicit_overlay
        .as_ref()
        .and_then(|v| v.as_ref())
        .is_some_and(|name| !overlay_name(name))
    {
        return Err(with_role(
            DocumentRole::Request,
            diagnostic_at(&document.positions, "invalid_name", "/explicit_overlay"),
        ));
    }
    let compiled = compile_inner(request.project.as_bytes(), profiles)
        .map_err(|d| with_role(DocumentRole::Project, d))?;
    let plan = &compiled.plan;
    let semantic_hash = &compiled.semantic_hash;
    // Even opted-out supplied primary input must be valid, and remains bound into the resolution generation.
    let primary = request
        .primary_local
        .as_deref()
        .map(|text| read_local(text, DocumentRole::PrimaryLocal))
        .transpose()?;
    let checkout = request
        .checkout_local
        .as_deref()
        .map(|text| read_local(text, DocumentRole::CheckoutLocal))
        .transpose()?;
    let mut overlay = plan.environment.default_overlay.clone();
    let mut origin = OverlayOrigin::Project;
    let mut overlay_location = with_role(
        DocumentRole::Project,
        diagnostic_at(
            &compiled.positions,
            "missing_overlay",
            "/environment/default_overlay",
        ),
    );
    if plan.worktree.inherit_local
        && let Some(input) = &primary
        && let Some(value) = &input.config.environment.default_overlay
    {
        overlay = value.clone();
        origin = OverlayOrigin::PrimaryLocal;
        overlay_location = input.overlay_location.clone();
    }
    if let Some(input) = &checkout
        && let Some(value) = &input.config.environment.default_overlay
    {
        overlay = value.clone();
        origin = OverlayOrigin::CheckoutLocal;
        overlay_location = input.overlay_location.clone();
    }
    if let Some(value) = &request.explicit_overlay {
        overlay = value.clone();
        origin = OverlayOrigin::Explicit;
        overlay_location = with_role(
            DocumentRole::Request,
            diagnostic_at(&document.positions, "missing_overlay", "/explicit_overlay"),
        );
    }
    let routing_context = crate::routing::Context {
        compiled: &compiled,
        request: &request,
        primary: primary.as_ref(),
        checkout: checkout.as_ref(),
        overlay: &overlay,
    };
    let routing_active = crate::routing::required(&routing_context);
    let routing_inputs_required =
        (request.routing_probe == Some(true) && routing_active).then_some(true);
    let routing_resolution = if request.routing_probe == Some(true) {
        None
    } else {
        crate::routing::resolve(routing_context)?
    };
    #[derive(Serialize)]
    struct ResolutionInputs<'a> {
        resolve_version: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        routing_inputs: Option<crate::routing::InputGeneration<'a>>,
        semantic_hash: &'a str,
        primary_local: Option<&'a LocalConfig>,
        checkout_local: Option<&'a LocalConfig>,
        #[serde(skip_serializing_if = "Option::is_none")]
        explicit_overlay: &'a Option<Option<String>>,
    }
    let encoded = serde_json::to_vec(&ResolutionInputs {
        resolve_version: 1,
        routing_inputs: routing_active.then_some(crate::routing::InputGeneration {
            global_domain: &request.global_domain,
            explicit_domain: &request.explicit_domain,
            branch: &request.branch,
        }),
        semantic_hash,
        primary_local: primary.as_ref().map(|input| &input.config),
        checkout_local: checkout.as_ref().map(|input| &input.config),
        explicit_overlay: &request.explicit_overlay,
    })
    .map_err(|_| {
        with_role(
            DocumentRole::Request,
            Diagnostic::new("encoding_failed", "", 1, 1),
        )
    })?;
    let local_resolution = LocalResolution {
        overlay,
        origin,
        auto_branch: plan.worktree.auto_branch,
        inherit_local: plan.worktree.inherit_local,
        resolution_hash: format!("{:x}", Sha256::digest(encoded)),
    };
    Ok(Resolved {
        compiled,
        local_resolution,
        overlay_location,
        routing_resolution,
        routing_inputs_required,
    })
}

pub fn local_schema() -> Result<String, serde_json::Error> {
    Ok(serde_json::to_string_pretty(&schemars::schema_for!(LocalConfig))? + "\n")
}
