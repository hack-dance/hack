//! WU03 Compose review and metadata-only enrollment. These plans cannot execute services.
mod compose;
mod enrollment;
pub mod execution;
pub mod inputs;
pub mod snapshot;
mod source;
pub mod watcher;
mod yaml;

use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub use enrollment::{EnrollmentReceipt, enroll, status};
pub use source::{SourceEntry, SourceSelection};

pub struct PlanOptions<'a> {
    pub project: &'a Path,
    pub compose_file: &'a Path,
    pub profiles: &'a [String],
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Diagnostic {
    pub severity: String,
    pub code: String,
    pub field: String,
    pub message: String,
}
impl Diagnostic {
    pub fn error(code: &str, field: &str, message: &str) -> Self {
        Self {
            severity: "error".into(),
            code: code.into(),
            field: field.into(),
            message: message.into(),
        }
    }
    pub fn warning(code: &str, field: &str, message: &str) -> Self {
        Self {
            severity: "warning".into(),
            code: code.into(),
            field: field.into(),
            message: message.into(),
        }
    }
}
fn problem(code: &'static str, message: &str) -> CandidateError {
    CandidateError::new(code, message)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct RedactedText {
    pub environment_references: Vec<String>,
    pub literal_redacted: bool,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct CommandPlan {
    pub form: String,
    pub arguments: Vec<RedactedText>,
    pub review_field: String,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct BuildPlan {
    pub context: String,
    pub dockerfile: String,
    pub target: Option<String>,
    pub arguments: BTreeMap<String, RedactedText>,
    pub context_policy: String,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct MountPlan {
    pub kind: String,
    pub source: String,
    pub target: String,
    pub read_only: bool,
    pub source_policy: String,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct PortPlan {
    pub target: u16,
    pub published: Option<u16>,
    pub protocol: String,
    pub declared_host_ip: String,
    pub proposed_host_ip: String,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct DependencyPlan {
    pub condition: String,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct HealthPlan {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_http: Option<crate::provider::http_probe::HttpProbe>,
    pub disabled: bool,
    pub test: Option<CommandPlan>,
    pub interval_nanos: Option<u64>,
    pub timeout_nanos: Option<u64>,
    pub start_period_nanos: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_interval_nanos: Option<u64>,
    pub retries: Option<u32>,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct LimitsPlan {
    pub cpus: Option<f64>,
    pub memory_bytes: Option<u64>,
    pub pids: Option<u32>,
    pub shared_memory_bytes: Option<u64>,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct ServicePlan {
    pub image: Option<String>,
    pub build: Option<BuildPlan>,
    pub command: Option<CommandPlan>,
    pub entrypoint: Option<CommandPlan>,
    pub profiles: Vec<String>,
    pub active: bool,
    pub dependencies: BTreeMap<String, DependencyPlan>,
    pub mounts: Vec<MountPlan>,
    pub environment: BTreeMap<String, RedactedText>,
    pub environment_files: Vec<String>,
    pub environment_precedence: String,
    pub healthcheck: Option<HealthPlan>,
    pub ports: Vec<PortPlan>,
    pub exposed_ports: Vec<String>,
    pub networks: Vec<String>,
    pub network_mode: String,
    pub limits: LimitsPlan,
    pub read_only: bool,
    pub init: bool,
    pub restart: String,
    pub working_dir: Option<String>,
    pub user: Option<RedactedText>,
    pub platform: Option<String>,
    pub labels: BTreeMap<String, RedactedText>,
    pub logging: Option<LoggingPlan>,
    pub stop_grace_period_nanos: Option<u64>,
    pub stop_signal: Option<String>,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct LoggingPlan {
    pub driver: String,
    pub options: BTreeMap<String, RedactedText>,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct NetworkPlan {
    pub driver: String,
    pub internal: bool,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct VolumePlan {
    pub driver: String,
    pub ownership: String,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct PlanData {
    pub schema_version: u32,
    pub kind: String,
    pub candidate_root: PathBuf,
    pub source: PathBuf,
    pub namespace: String,
    pub compose_file: String,
    pub compose_sha256: String,
    pub active_profiles: Vec<String>,
    pub services: BTreeMap<String, ServicePlan>,
    pub networks: BTreeMap<String, NetworkPlan>,
    pub volumes: BTreeMap<String, VolumePlan>,
    pub source_selection: SourceSelection,
    pub diagnostics: Vec<Diagnostic>,
    pub enrollment_compatible: bool,
    pub runtime_execution_supported: bool,
    pub planned_effects: Vec<String>,
    pub execution_gates: Vec<String>,
}
#[derive(Debug, Serialize)]
pub struct EnrollmentDiff {
    pub state: String,
    pub prior_plan_id: Option<String>,
    pub added_services: Vec<String>,
    pub removed_services: Vec<String>,
    pub compose_changed: bool,
    pub source_selection_changed: bool,
}
#[derive(Debug, Serialize)]
pub struct PlanReport {
    pub plan_id: String,
    pub plan: PlanData,
    pub enrollment_diff: EnrollmentDiff,
}

pub(crate) fn identity(plan: &PlanData) -> Result<String, CandidateError> {
    let bytes = serde_json::to_vec(plan)
        .map_err(|_| problem("serialization_failed", "Cannot encode review plan."))?;
    if bytes.len() > 3 * 1024 * 1024 {
        return Err(problem("plan_budget", "Review plan exceeds 3 MiB."));
    }
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub fn plan(candidate: &Candidate, options: PlanOptions<'_>) -> Result<PlanReport, CandidateError> {
    if options.profiles.len() > 64 {
        return Err(problem(
            "profile_budget",
            "At most 64 profiles can be selected.",
        ));
    }
    let preview = candidate.plan(options.project)?;
    let source = &preview.source;
    let file_text = options
        .compose_file
        .to_str()
        .ok_or_else(|| problem("invalid_compose_path", "Compose path must be valid UTF-8."))?;
    let path = source::resolve(source, source, file_text, false)?;
    let bytes = source::read_compose(&path)?;
    let value = yaml::parse(&bytes)?;
    let mut profiles = options.profiles.to_vec();
    profiles.sort();
    profiles.dedup();
    for profile in &profiles {
        compose::identifier(profile)?;
    }
    let relative = path
        .strip_prefix(source)
        .expect("source path checked")
        .to_string_lossy()
        .into_owned();
    let mut data = compose::compile(
        candidate,
        source,
        path.parent().expect("compose parent"),
        &relative,
        &bytes,
        &profiles,
        value,
    )?;
    data.namespace = preview.namespace;
    let environment_files = data
        .services
        .values()
        .flat_map(|service| service.environment_files.iter().cloned())
        .collect();
    data.source_selection = source::inventory(source, &environment_files, &mut data.diagnostics)?;
    data.diagnostics.sort_by(|a, b| {
        (&a.severity, &a.code, &a.field, &a.message).cmp(&(
            &b.severity,
            &b.code,
            &b.field,
            &b.message,
        ))
    });
    data.enrollment_compatible = !data.diagnostics.iter().any(|d| d.severity == "error");
    // Re-read only the explicitly selected config; a changed plan is never silently enrolled.
    if source::read_compose(&path)? != bytes {
        return Err(problem(
            "compose_changed",
            "Compose input changed during planning.",
        ));
    }
    let plan_id = identity(&data)?;
    let existing = enrollment::read(candidate, source, &data.namespace)?;
    let enrollment_diff = match existing {
        None => EnrollmentDiff {
            state: "new".into(),
            prior_plan_id: None,
            added_services: data.services.keys().cloned().collect(),
            removed_services: vec![],
            compose_changed: false,
            source_selection_changed: false,
        },
        Some(previous) => EnrollmentDiff {
            state: if previous.plan_id == plan_id {
                "unchanged"
            } else {
                "different-plan-replacement-not-implemented"
            }
            .into(),
            prior_plan_id: Some(previous.plan_id),
            added_services: data
                .services
                .keys()
                .filter(|k| !previous.plan.services.contains_key(*k))
                .cloned()
                .collect(),
            removed_services: previous
                .plan
                .services
                .keys()
                .filter(|k| !data.services.contains_key(*k))
                .cloned()
                .collect(),
            compose_changed: data.compose_sha256 != previous.plan.compose_sha256,
            source_selection_changed: data.source_selection.metadata_sha256
                != previous.plan.source_selection.metadata_sha256,
        },
    };
    Ok(PlanReport {
        plan_id,
        plan: data,
        enrollment_diff,
    })
}
