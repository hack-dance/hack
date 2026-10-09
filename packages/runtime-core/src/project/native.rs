//! Pure native compiler output to dependency IR. No provider, filesystem or receipt effects.
use super::execution::{Condition, Graph, Service};
use crate::CandidateError;
use hack_config_compiler::{
    WorkloadKind,
    environment::{EnvironmentBinding, EnvironmentPlan, PlanResult},
    local::LocalResolution,
    model::{
        Access, Command, Dependency, EnvironmentValue, Mount, Plan, Readiness, ServiceCondition,
        Source, SourceMode, Workload, WorktreePolicy,
    },
    process::{Entrypoint, Restart, ShutdownSignal},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// Caller-selected private values keyed by workload, then the compiler binding's source key.
/// Never serialize, log or hash this map into a public identity.
pub type ManagedValues = BTreeMap<String, BTreeMap<String, String>>;

/// Compiler metadata request and private delivery remain independent inputs.
pub struct CompileOptions<'a> {
    /// The existing compiler EnvPlanRequest wire: raw authored text, locals and metadata only.
    pub request: &'a [u8],
    pub profiles: &'a [String],
    /// Exactly the source keys selected by managed bindings, after unset/profile selection.
    pub managed_values: &'a ManagedValues,
}

/// Ephemeral adapter output, deliberately without Debug or Serialize.
/// No source ownership, image availability, backend capability or runtime admission is implied.
pub struct NativeInputs {
    pub semantic_hash: String,
    pub environment_policy_hash: String,
    pub local_resolution: LocalResolution,
    pub source: Source,
    pub worktree: WorktreePolicy,
    pub selected_profiles: Vec<String>,
    pub graph: Graph,
    pub workloads: BTreeMap<String, WorkloadInputs>,
    /// Selected persistent/worktree logical storage names; no provider volume identity.
    pub storage: BTreeSet<String>,
    /// Closed authored two-bridge topology. Omission retains the implicit outbound bridge.
    pub topology: Option<NetworkTopology>,
    /// Destination keys only; values cannot enter public engine configuration or receipts.
    pub managed_environment: ManagedValues,
}

/// Compiler-selected logical topology, without physical engine identities.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NetworkTopology {
    /// Logical bridge name to its internal policy.
    pub networks: BTreeMap<String, bool>,
    /// Workload to logical bridge to its compiler-normalized extra DNS aliases.
    pub attachments: BTreeMap<String, BTreeMap<String, Vec<String>>>,
}

/// Public compiler identity only. Managed values and executable text are excluded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewIdentity {
    pub semantic_hash: String,
    pub local_resolution_hash: String,
    pub environment_policy_hash: String,
    pub selected_profiles: Vec<String>,
}
impl NativeInputs {
    pub fn review_identity(&self) -> ReviewIdentity {
        ReviewIdentity {
            semantic_hash: self.semantic_hash.clone(),
            local_resolution_hash: self.local_resolution.resolution_hash.clone(),
            environment_policy_hash: self.environment_policy_hash.clone(),
            selected_profiles: self.selected_profiles.clone(),
        }
    }
}

fn policy_hash(plan: &Plan, bindings: &EnvironmentPlan) -> Result<String, CandidateError> {
    #[derive(Serialize)]
    struct Policy<'a> {
        directives: BTreeMap<&'a str, &'a BTreeMap<String, EnvironmentValue>>,
        bindings: &'a EnvironmentPlan,
    }
    let policy = Policy {
        directives: plan
            .services
            .iter()
            .chain(plan.jobs.iter())
            .map(|(name, workload)| (name.as_str(), &workload.environment))
            .collect(),
        bindings,
    };
    let bytes = serde_json::to_vec(&policy).map_err(|_| private_refused())?;
    let mut hash = Sha256::new();
    hash.update(b"hack.native-environment-policy/v1\0");
    hash.update(bytes);
    Ok(format!("{:x}", hash.finalize()))
}

/// Authored process and public environment, not a provider create request or durable plan.
/// Omitted image defaults and explicitly empty entrypoints remain distinguishable.
pub struct WorkloadInputs {
    pub kind: WorkloadKind,
    pub image: String,
    pub command: Option<Vec<String>>,
    pub entrypoint: Option<Vec<String>>,
    pub init: Option<bool>,
    pub shutdown: Option<Shutdown>,
    pub restart: Option<Restart>,
    pub working_directory: Option<String>,
    pub source_mount: Option<SourceMount>,
    pub environment: BTreeMap<String, String>,
    pub readiness: Option<ExecReadiness>,
    pub mounts: Vec<StorageMount>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StorageMount {
    pub storage: String,
    pub target: String,
    pub read_only: bool,
}

/// Compiler-normalized source and destination; live sharing is admitted separately.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceMount {
    pub source: String,
    pub target: String,
}

/// Millisecond precision is retained; a future backend must qualify signal/timing delivery.
pub struct Shutdown {
    pub signal: Option<ShutdownSignal>,
    pub grace_ms: Option<u32>,
}

pub struct ExecReadiness {
    /// Same CMD argv contract as the NC03 renderer, without Compose dollar escaping.
    pub test: Vec<String>,
    pub interval_ms: u32,
    pub timeout_ms: u32,
    pub retries: u32,
}

fn refused() -> CandidateError {
    CandidateError::new(
        "native_graph_subset",
        "Native graph adapter requires images, exec readiness and a closed source, storage or two-owned-bridge intent; mixed source/storage/topology, acquisition, other mounts, external networks, routing, endpoints, host effects and automatic restart remain unsupported; values omitted.",
    )
}

fn private_refused() -> CandidateError {
    CandidateError::new(
        "native_graph_environment",
        "Private values must match the compiler-selected active workload bindings and fit delivery bounds; values omitted.",
    )
}

// Count JSON delivery bytes without producing a serialized copy of private values.
fn json_string_bytes(value: &str) -> usize {
    2 + value
        .chars()
        .map(|character| match character {
            '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
            character if character < ' ' => 6,
            character => character.len_utf8(),
        })
        .sum::<usize>()
}

fn milliseconds(value: &str) -> Result<u32, CandidateError> {
    value
        .strip_suffix("ms")
        .and_then(|digits| digits.parse().ok())
        .filter(|value| *value > 0)
        .ok_or_else(refused)
}

fn checked_argv(values: Vec<String>) -> Result<Vec<String>, CandidateError> {
    if values.len() > 4096 || values.iter().map(|value| value.len() + 1).sum::<usize>() > 64 * 1024
    {
        return Err(refused());
    }
    Ok(values)
}

fn command(value: Command) -> Result<Vec<String>, CandidateError> {
    checked_argv(match value {
        Command::Exec { exec } => exec,
        Command::Shell { shell } => vec!["/bin/sh".into(), "-c".into(), shell],
    })
}

fn entrypoint(value: Entrypoint) -> Result<Vec<String>, CandidateError> {
    checked_argv(match value {
        Entrypoint::Exec { exec } => exec,
        Entrypoint::Shell { shell } => vec![
            "/bin/sh".into(),
            "-c".into(),
            shell,
            "hack-native-entrypoint".into(),
        ],
    })
}

fn workload(value: Workload, kind: WorkloadKind) -> Result<WorkloadInputs, CandidateError> {
    if value.build.is_some()
        || value.pull_policy.is_some()
        || (value.entrypoint.is_some() && value.command.is_none())
        || value
            .restart
            .as_ref()
            .is_some_and(|restart| !matches!(restart, Restart::No {}))
    {
        return Err(refused());
    }
    let mut source_mount = None;
    let mut mounts = Vec::new();
    for mount in value.mounts {
        match mount {
            Mount::Source {
                source,
                target,
                access: Access::ReadOnly,
            } if source_mount.is_none() => {
                source_mount = Some(SourceMount { source, target });
            }
            Mount::Storage {
                storage,
                target,
                access,
            } if !storage.is_empty()
                && storage.len() <= 63
                && storage.bytes().enumerate().all(|(index, byte)| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || (index > 0 && matches!(byte, b'-' | b'_' | b'.'))
                })
                && target != "/" =>
            {
                mounts.push(StorageMount {
                    storage,
                    target,
                    read_only: matches!(access, Access::ReadOnly),
                });
            }
            _ => return Err(refused()),
        }
    }
    if source_mount.is_some() && !mounts.is_empty() {
        return Err(refused());
    }
    let readiness = value
        .readiness
        .map(|check| match check {
            Readiness::Exec {
                command: argv,
                interval,
                timeout,
                retries,
            } => {
                let mut test = vec!["CMD".into()];
                test.extend(command(argv)?);
                Ok(ExecReadiness {
                    test,
                    interval_ms: milliseconds(&interval)?,
                    timeout_ms: milliseconds(&timeout)?,
                    retries,
                })
            }
            _ => Err(refused()),
        })
        .transpose()?;
    let shutdown = value
        .shutdown
        .map(|shutdown| {
            Ok(Shutdown {
                signal: shutdown.signal,
                grace_ms: shutdown.grace.as_deref().map(milliseconds).transpose()?,
            })
        })
        .transpose()?;
    Ok(WorkloadInputs {
        kind,
        image: value.image.ok_or_else(refused)?,
        command: value.command.map(command).transpose()?,
        entrypoint: value.entrypoint.map(entrypoint).transpose()?,
        init: value.init,
        shutdown,
        restart: value.restart,
        working_directory: value.working_directory,
        source_mount,
        environment: BTreeMap::new(),
        readiness,
        mounts,
    })
}

/// Compile through the owning Rust compiler, then lower a bounded typed subset.
/// Managed metadata selection, precedence, remapping, defaults/unset, profiles and
/// diagnostics remain compiler-owned. Neither caller-private values nor a cached JSON
/// plan are sent through the compiler. Errors never disclose authored or private text.
/// Provider entry points do not consume this result; execution/replay remain later gates.
pub fn compile(options: CompileOptions<'_>) -> Result<NativeInputs, CandidateError> {
    compile_inputs(
        options.request,
        options.profiles,
        Some(options.managed_values),
    )
}

/// Review the same supported typed subset without acquiring private values.
/// Preparation must recompile with the exact managed selection and compare this identity.
pub fn review(request: &[u8], profiles: &[String]) -> Result<ReviewIdentity, CandidateError> {
    review_inputs(request, profiles).map(|inputs| inputs.review_identity())
}

pub(crate) fn review_inputs(
    request: &[u8],
    profiles: &[String],
) -> Result<NativeInputs, CandidateError> {
    compile_inputs(request, profiles, None)
}

#[cfg(test)]
thread_local! {
    // Count copies, never retain or report private contents. Each test owns its thread.
    static PRIVATE_COPIES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn copy_private(value: &str) -> String {
    #[cfg(test)]
    PRIVATE_COPIES.with(|copies| copies.set(copies.get() + 1));
    value.into()
}

fn compile_inputs(
    request: &[u8],
    profiles: &[String],
    managed_values: Option<&ManagedValues>,
) -> Result<NativeInputs, CandidateError> {
    let PlanResult::Success {
        plan,
        semantic_hash,
        local_resolution,
        environment_plan,
        ..
    } = hack_config_compiler::environment::plan(request, profiles)
    else {
        return Err(CandidateError::new(
            "native_graph_compile",
            "Native compiler metadata planning failed; values omitted.",
        ));
    };
    // Presence remains unqualified even when definitions are empty or grants inactive.
    // The owning compiler has enforced its request and authored-document bounds before
    // this raw scan. Inspect original presence before hashes or private copies, because
    // normalization can omit empty definitions and inactive grants.
    if serde_json::from_slice::<serde_json::Value>(request)
        .ok()
        .and_then(|request| {
            request
                .get("project")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .and_then(|source| serde_json::from_str::<serde_json::Value>(&source).ok())
        .is_some_and(|source| source.get("configs").is_some() || source.get("secrets").is_some())
    {
        return Err(refused());
    }
    if !environment_plan.complete || !environment_plan.diagnostics.is_empty() {
        return Err(private_refused());
    }
    let topology = authored_network_intent(request, &plan)?;
    let environment_policy_hash = policy_hash(&plan, &environment_plan)?;
    let source_bearing = plan
        .services
        .values()
        .chain(plan.jobs.values())
        .any(|workload| {
            workload
                .mounts
                .iter()
                .any(|mount| matches!(mount, Mount::Source { .. }))
        });
    if source_bearing
        && (!matches!(&plan.source.mode, SourceMode::HostMounted)
            || !plan.storage.is_empty()
            || topology.is_some())
    {
        return Err(refused());
    }
    if topology.is_some() && !plan.storage.is_empty() {
        return Err(refused());
    }
    if plan.source.root != "."
        || !plan.configs.is_empty()
        || !plan.secrets.is_empty()
        || plan.routes.is_some()
        || plan.open.is_some()
        || plan.host_bindings.is_some()
        || plan.host.is_some()
    {
        return Err(refused());
    }
    if plan.services.len() + plan.jobs.len() > 32 {
        return Err(refused());
    }
    let mut graph = BTreeMap::new();
    let mut workloads = BTreeMap::new();
    // Validate every fallible workload/binding/graph condition before copying any
    // private value. A later refusal must not leave partially accumulated copies.
    for (kind, selected) in [
        (WorkloadKind::Service, plan.services),
        (WorkloadKind::Job, plan.jobs),
    ] {
        for (name, value) in selected {
            let dependencies = value
                .depends_on
                .iter()
                .map(|dependency| {
                    let condition = match dependency {
                        Dependency::Service {
                            condition: ServiceCondition::Started,
                            ..
                        } => Condition::Started,
                        Dependency::Service {
                            condition: ServiceCondition::Ready,
                            ..
                        } => Condition::Healthy,
                        Dependency::Job { .. } => Condition::Completed,
                    };
                    (dependency.name().to_owned(), condition)
                })
                .collect();
            let ready = match kind {
                WorkloadKind::Job => Condition::Completed,
                WorkloadKind::Service if value.readiness.is_some() => Condition::Healthy,
                WorkloadKind::Service => Condition::Started,
            };
            let mut inputs = workload(value, kind.clone())?;
            let bindings = environment_plan
                .workloads
                .get(&name)
                .ok_or_else(private_refused)?;
            let private = managed_values.and_then(|values| values.get(&name));
            let mut source_keys = BTreeSet::new();
            let mut managed_count = 0;
            let mut private_bytes = 2;
            for (destination, binding) in bindings {
                match binding {
                    EnvironmentBinding::Managed { key, .. } => {
                        source_keys.insert(key);
                        managed_count += 1;
                        if managed_count > 256 {
                            return Err(private_refused());
                        }
                        if managed_values.is_none() {
                            continue;
                        }
                        let value = private
                            .and_then(|values| values.get(key))
                            .ok_or_else(private_refused)?;
                        if value.len() > 32 * 1024 || value.contains('\0') {
                            return Err(private_refused());
                        }
                        private_bytes += destination.len()
                            + 3
                            + json_string_bytes(value)
                            + usize::from(managed_count > 1);
                        if private_bytes > 32 * 1024 {
                            return Err(private_refused());
                        }
                    }
                    EnvironmentBinding::Literal { value }
                    | EnvironmentBinding::Default { value } => {
                        inputs
                            .environment
                            .insert(destination.clone(), value.clone());
                    }
                    EnvironmentBinding::Endpoint { .. } => return Err(refused()),
                }
            }
            if private.is_some_and(|values| values.keys().collect::<BTreeSet<_>>() != source_keys) {
                return Err(private_refused());
            }
            graph.insert(
                name.clone(),
                Service {
                    dependencies,
                    ready,
                },
            );
            workloads.insert(name, inputs);
        }
    }
    if managed_values.is_some_and(|values| values.keys().any(|name| !workloads.contains_key(name)))
    {
        return Err(private_refused());
    }
    let graph = Graph::from_services(graph)?;
    let storage = workloads
        .values()
        .flat_map(|workload| workload.mounts.iter().map(|mount| mount.storage.clone()))
        .collect();
    // No ordinary error path remains after the first copy. The borrowed source
    // map and owning compiler bindings cannot change between validation and copy.
    let mut managed_environment = BTreeMap::new();
    if let Some(selected) = managed_values {
        for name in workloads.keys() {
            let destinations: BTreeMap<_, _> = environment_plan.workloads[name]
                .iter()
                .filter_map(|(destination, binding)| match binding {
                    EnvironmentBinding::Managed { key, .. } => {
                        Some((destination.clone(), copy_private(&selected[name][key])))
                    }
                    _ => None,
                })
                .collect();
            if !destinations.is_empty() {
                managed_environment.insert(name.clone(), destinations);
            }
        }
    }
    Ok(NativeInputs {
        semantic_hash,
        environment_policy_hash,
        local_resolution,
        source: plan.source,
        worktree: plan.worktree,
        selected_profiles: plan.selected_profiles,
        graph,
        workloads,
        storage,
        topology,
        managed_environment,
    })
}

/// The compiler can admit topology before this execution adapter qualifies it.
/// Inspect authored presence after owning compiler validation so empty declarations
/// and inactive attachments cannot disappear through normalization/profile pruning.
fn authored_network_intent(
    request: &[u8],
    plan: &Plan,
) -> Result<Option<NetworkTopology>, CandidateError> {
    let envelope: serde_json::Value = serde_json::from_slice(request).map_err(|_| refused())?;
    let authored = envelope["project"].as_str().ok_or_else(refused)?;
    let project: serde_json::Value = serde_json::from_str(authored).map_err(|_| refused())?;
    let object = project.as_object().ok_or_else(refused)?;
    let authored = object.contains_key("networks")
        || ["services", "jobs"].into_iter().any(|field| {
            object
                .get(field)
                .and_then(serde_json::Value::as_object)
                .is_some_and(|workloads| {
                    workloads.values().any(|workload| {
                        workload
                            .as_object()
                            .is_some_and(|workload| workload.contains_key("networks"))
                    })
                })
        });
    if !authored {
        return Ok(None);
    }
    let networks = plan.networks.as_ref().ok_or_else(refused)?;
    if networks.len() != 2
        || networks.values().filter(|network| network.internal).count() != 1
        || object
            .get("networks")
            .and_then(serde_json::Value::as_object)
            .is_none_or(|raw| {
                raw.len() != 2 || raw.keys().collect::<BTreeSet<_>>() != networks.keys().collect()
            })
    {
        return Err(refused());
    }
    let mut attachments = BTreeMap::new();
    let mut used = BTreeSet::new();
    for field in ["services", "jobs"] {
        if let Some(authored_workloads) = object.get(field).and_then(serde_json::Value::as_object) {
            for workload in authored_workloads.values() {
                let selected = workload
                    .get("networks")
                    .and_then(serde_json::Value::as_object)
                    .ok_or_else(refused)?;
                if selected.is_empty() || selected.keys().any(|key| !networks.contains_key(key)) {
                    return Err(refused());
                }
            }
        }
    }
    for (name, workload) in plan.services.iter().chain(plan.jobs.iter()) {
        let selected = workload.networks.as_ref().ok_or_else(refused)?;
        if selected.is_empty() || selected.keys().any(|key| !networks.contains_key(key)) {
            return Err(refused());
        }
        for key in selected.keys() {
            used.insert(key.clone());
        }
        attachments.insert(
            name.clone(),
            selected
                .iter()
                .map(|(key, attachment)| (key.clone(), attachment.aliases.clone()))
                .collect(),
        );
    }
    if used.into_iter().ne(networks.keys().cloned()) {
        return Err(refused());
    }
    Ok(Some(NetworkTopology {
        networks: networks
            .iter()
            .map(|(name, network)| (name.clone(), network.internal))
            .collect(),
        attachments,
    }))
}

#[cfg(test)]
mod tests;
