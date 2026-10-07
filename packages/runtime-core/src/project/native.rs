//! Pure native compiler output to dependency IR. No provider, filesystem or receipt effects.
use super::execution::{Condition, Graph, Service};
use crate::CandidateError;
use hack_config_compiler::{
    WorkloadKind,
    environment::{EnvironmentBinding, PlanResult},
    local::LocalResolution,
    model::{Command, Dependency, Readiness, ServiceCondition, Source, Workload, WorktreePolicy},
    process::{Entrypoint, Restart, ShutdownSignal},
};
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
    pub local_resolution: LocalResolution,
    pub source: Source,
    pub worktree: WorktreePolicy,
    pub selected_profiles: Vec<String>,
    pub graph: Graph,
    pub workloads: BTreeMap<String, WorkloadInputs>,
    /// Destination keys only; values cannot enter public engine configuration or receipts.
    pub managed_environment: ManagedValues,
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
    pub environment: BTreeMap<String, String>,
    pub readiness: Option<ExecReadiness>,
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
        "Native graph adapter requires image-only workloads, exec readiness and no acquisition, mounts, storage, routing, endpoints, host effects or automatic restart; values omitted.",
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
        || !value.mounts.is_empty()
        || (value.entrypoint.is_some() && value.command.is_none())
        || value
            .restart
            .as_ref()
            .is_some_and(|restart| !matches!(restart, Restart::No {}))
    {
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
        environment: BTreeMap::new(),
        readiness,
    })
}

/// Compile through the owning Rust compiler, then lower a bounded typed subset.
/// Managed metadata selection, precedence, remapping, defaults/unset, profiles and
/// diagnostics remain compiler-owned. Neither caller-private values nor a cached JSON
/// plan are sent through the compiler. Errors never disclose authored or private text.
/// Provider entry points do not consume this result; execution/replay remain later gates.
pub fn compile(options: CompileOptions<'_>) -> Result<NativeInputs, CandidateError> {
    let PlanResult::Success {
        plan,
        semantic_hash,
        local_resolution,
        environment_plan,
        ..
    } = hack_config_compiler::environment::plan(options.request, options.profiles)
    else {
        return Err(CandidateError::new(
            "native_graph_compile",
            "Native compiler metadata planning failed; values omitted.",
        ));
    };
    if !environment_plan.complete || !environment_plan.diagnostics.is_empty() {
        return Err(private_refused());
    }
    if !plan.storage.is_empty()
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
    let mut managed_environment = BTreeMap::new();
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
            let private = options.managed_values.get(&name);
            let mut source_keys = BTreeSet::new();
            let mut destinations = BTreeMap::new();
            let mut private_bytes = 2;
            for (destination, binding) in bindings {
                match binding {
                    EnvironmentBinding::Managed { key, .. } => {
                        source_keys.insert(key);
                        let value = private
                            .and_then(|values| values.get(key))
                            .ok_or_else(private_refused)?;
                        if value.len() > 32 * 1024
                            || value.contains('\0')
                            || destinations.len() == 256
                        {
                            return Err(private_refused());
                        }
                        private_bytes += destination.len()
                            + 3
                            + json_string_bytes(value)
                            + usize::from(!destinations.is_empty());
                        if private_bytes > 32 * 1024 {
                            return Err(private_refused());
                        }
                        destinations.insert(destination.clone(), value.clone());
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
            if !destinations.is_empty() {
                managed_environment.insert(name.clone(), destinations);
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
    if options
        .managed_values
        .keys()
        .any(|name| !workloads.contains_key(name))
    {
        return Err(private_refused());
    }
    Ok(NativeInputs {
        semantic_hash,
        local_resolution,
        source: plan.source,
        worktree: plan.worktree,
        selected_profiles: plan.selected_profiles,
        graph: Graph::from_services(graph)?,
        workloads,
        managed_environment,
    })
}

#[cfg(test)]
mod tests;
