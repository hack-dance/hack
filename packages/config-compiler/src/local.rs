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
}

#[derive(Debug, Clone, Copy, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum DocumentRole {
    Project,
    PrimaryLocal,
    CheckoutLocal,
    Request,
}
#[derive(Debug, Serialize, JsonSchema, TS)]
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
        local_resolution: LocalResolution,
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
fn with_role(document: DocumentRole, diagnostic: Diagnostic) -> ResolveDiagnostic {
    ResolveDiagnostic {
        document,
        diagnostic,
    }
}
fn decode<T: serde::de::DeserializeOwned>(
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
fn read_local(text: &str, role: DocumentRole) -> Result<LocalConfig, ResolveDiagnostic> {
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
    let local: LocalConfig = decode(&document, role)?;
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
    Ok(local)
}

/// Resolve only the explicitly supplied original documents. No discovery, acquisition or decryption.
pub fn resolve(bytes: &[u8], profiles: &[String]) -> ResolveResult {
    match resolve_inner(bytes, profiles) {
        Ok((plan, semantic_hash, local_resolution)) => ResolveResult::Success {
            transport_version: 1,
            ok: true,
            plan: Box::new(plan),
            semantic_hash,
            local_resolution,
        },
        Err(diagnostic) => ResolveResult::Failure {
            transport_version: 1,
            ok: false,
            diagnostics: vec![diagnostic],
        },
    }
}
fn resolve_inner(
    bytes: &[u8],
    profiles: &[String],
) -> Result<(Plan, String, LocalResolution), ResolveDiagnostic> {
    let document = json::parse_with_limit(bytes, MAX_REQUEST_BYTES)
        .map_err(|d| with_role(DocumentRole::Request, d))?;
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
    let (plan, semantic_hash) = compile_inner(request.project.as_bytes(), profiles)
        .map_err(|d| with_role(DocumentRole::Project, d))?;
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
    if plan.worktree.inherit_local
        && let Some(value) = primary
            .as_ref()
            .and_then(|v| v.environment.default_overlay.as_ref())
    {
        overlay = value.clone();
        origin = OverlayOrigin::PrimaryLocal;
    }
    if let Some(value) = checkout
        .as_ref()
        .and_then(|v| v.environment.default_overlay.as_ref())
    {
        overlay = value.clone();
        origin = OverlayOrigin::CheckoutLocal;
    }
    if let Some(value) = &request.explicit_overlay {
        overlay = value.clone();
        origin = OverlayOrigin::Explicit;
    }
    #[derive(Serialize)]
    struct ResolutionInputs<'a> {
        resolve_version: u32,
        semantic_hash: &'a str,
        primary_local: &'a Option<LocalConfig>,
        checkout_local: &'a Option<LocalConfig>,
        #[serde(skip_serializing_if = "Option::is_none")]
        explicit_overlay: &'a Option<Option<String>>,
    }
    let encoded = serde_json::to_vec(&ResolutionInputs {
        resolve_version: 1,
        semantic_hash: &semantic_hash,
        primary_local: &primary,
        checkout_local: &checkout,
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
    Ok((plan, semantic_hash, local_resolution))
}

pub fn local_schema() -> Result<String, serde_json::Error> {
    Ok(serde_json::to_string_pretty(&schemars::schema_for!(LocalConfig))? + "\n")
}
