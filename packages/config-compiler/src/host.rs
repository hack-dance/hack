//! Typed host intent only. No process execution, port observation or adoption occurs here.
use crate::{
    Diagnostic,
    json::child,
    model::{Command, EnvironmentValue},
    validate,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use ts_rs::TS;

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct HostConfig {
    #[serde(default)]
    #[ts(optional, as = "Option<HostHooks>")]
    pub up: HostHooks,
    #[serde(default)]
    #[ts(optional, as = "Option<HostHooks>")]
    pub down: HostHooks,
    #[serde(default)]
    #[ts(optional, as = "Option<BTreeMap<String,HostProcess>>")]
    pub processes: BTreeMap<String, HostProcess>,
}
#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct HostHooks {
    #[serde(default)]
    #[ts(optional, as = "Option<Vec<HostHook>>")]
    pub before: Vec<HostHook>,
    #[serde(default)]
    #[ts(optional, as = "Option<Vec<HostHook>>")]
    pub after: Vec<HostHook>,
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct HostHook {
    pub name: String,
    pub command: Command,
    #[serde(default = "crate::model::dot")]
    #[ts(optional, as = "Option<String>")]
    pub cwd: String,
    #[serde(default)]
    #[ts(optional, as = "Option<BTreeMap<String,EnvironmentValue>>")]
    pub environment: BTreeMap<String, EnvironmentValue>,
    #[serde(default)]
    #[ts(optional, as = "Option<HostEnvTarget>")]
    pub env_target: HostEnvTarget,
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct HostProcess {
    pub command: Command,
    #[serde(default = "crate::model::dot")]
    #[ts(optional, as = "Option<String>")]
    pub cwd: String,
    #[serde(default)]
    #[ts(optional, as = "Option<BTreeMap<String,EnvironmentValue>>")]
    pub environment: BTreeMap<String, EnvironmentValue>,
    #[serde(default)]
    #[ts(optional, as = "Option<HostEnvTarget>")]
    pub env_target: HostEnvTarget,
    #[serde(default)]
    #[ts(optional, as = "Option<HostStartup>")]
    pub startup: HostStartup,
    #[serde(default)]
    #[ts(optional, as = "Option<HostExit>")]
    pub exit: HostExit,
    #[serde(
        default,
        deserialize_with = "crate::model::present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "HostSingleton")]
    #[ts(optional, type = "HostSingleton")]
    pub singleton: Option<HostSingleton>,
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostEnvTarget {
    Host {},
    Workload { name: String },
}
impl Default for HostEnvTarget {
    fn default() -> Self {
        Self::Host {}
    }
}
#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HostStartup {
    #[default]
    Up,
}
#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HostExit {
    #[default]
    StopOnDown,
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct HostSingleton {
    #[schemars(length(min=1),extend("uniqueItems"=true))]
    pub ports: Vec<u16>,
    #[serde(default)]
    #[ts(optional, as = "Option<HostConflict>")]
    pub on_conflict: HostConflict,
}
#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HostConflict {
    #[default]
    Fail,
    Adopt,
}
#[derive(Debug, Clone, Serialize, JsonSchema, TS)]
pub struct HostEnvTargets {
    pub include_default: bool,
    pub workloads: Vec<String>,
}

pub(crate) struct Entry<'a> {
    pub name: &'a str,
    pub pointer: String,
    pub environment: &'a BTreeMap<String, EnvironmentValue>,
    pub target: &'a HostEnvTarget,
}
impl HostConfig {
    pub(crate) fn entries(&self) -> Vec<Entry<'_>> {
        let mut result = Vec::new();
        for (phase, hooks) in [("up", &self.up), ("down", &self.down)] {
            for (stage, items) in [("before", &hooks.before), ("after", &hooks.after)] {
                for (i, hook) in items.iter().enumerate() {
                    result.push(Entry {
                        name: &hook.name,
                        pointer: format!("/host/{phase}/{stage}/{i}"),
                        environment: &hook.environment,
                        target: &hook.env_target,
                    });
                }
            }
        }
        for (name, process) in &self.processes {
            result.push(Entry {
                name,
                pointer: child("/host/processes", name),
                environment: &process.environment,
                target: &process.env_target,
            });
        }
        result
    }
    pub(crate) fn targets(&self) -> HostEnvTargets {
        let mut include_default = false;
        let mut workloads = BTreeSet::new();
        for entry in self.entries() {
            match entry.target {
                HostEnvTarget::Host {} => include_default = true,
                HostEnvTarget::Workload { name } => {
                    workloads.insert(name.clone());
                }
            }
        }
        HostEnvTargets {
            include_default,
            workloads: workloads.into_iter().collect(),
        }
    }
    pub(crate) fn empty(&self) -> bool {
        self.up.before.is_empty()
            && self.up.after.is_empty()
            && self.down.before.is_empty()
            && self.down.after.is_empty()
            && self.processes.is_empty()
    }
}

pub(crate) fn normalize(
    host: &mut HostConfig,
    workloads: &BTreeSet<String>,
    at: &dyn Fn(&str, &str) -> Diagnostic,
) -> Result<(), Diagnostic> {
    let mut names = BTreeSet::new();
    for entry in host.entries() {
        if !validate::name(entry.name) || !names.insert(entry.name.to_owned()) {
            return Err(at("invalid_name", &entry.pointer));
        }
        if let HostEnvTarget::Workload { name } = entry.target
            && !workloads.contains(name)
        {
            return Err(at(
                "unknown_env_target",
                &child(&entry.pointer, "env_target"),
            ));
        }
    }
    for (phase, hooks) in [("up", &mut host.up), ("down", &mut host.down)] {
        for (stage, items) in [("before", &mut hooks.before), ("after", &mut hooks.after)] {
            for (i, hook) in items.iter_mut().enumerate() {
                invocation(
                    &hook.command,
                    &mut hook.cwd,
                    &hook.environment,
                    &format!("/host/{phase}/{stage}/{i}"),
                    at,
                )?;
            }
        }
    }
    for (name, process) in &mut host.processes {
        let pointer = child("/host/processes", name);
        invocation(
            &process.command,
            &mut process.cwd,
            &process.environment,
            &pointer,
            at,
        )?;
        if let Some(singleton) = &mut process.singleton {
            let mut ports = BTreeSet::new();
            if singleton.ports.is_empty()
                || singleton.ports.iter().any(|p| *p == 0 || !ports.insert(*p))
            {
                return Err(at(
                    "invalid_singleton",
                    &format!("{pointer}/singleton/ports"),
                ));
            }
            singleton.ports.sort();
        }
    }
    Ok(())
}
fn invocation(
    command: &Command,
    cwd: &mut String,
    environment: &BTreeMap<String, EnvironmentValue>,
    pointer: &str,
    at: &dyn Fn(&str, &str) -> Diagnostic,
) -> Result<(), Diagnostic> {
    validate::command(command, &child(pointer, "command"), at)?;
    *cwd = validate::relative(cwd).ok_or_else(|| at("invalid_path", &child(pointer, "cwd")))?;
    validate::environment(environment, pointer, at)
}
