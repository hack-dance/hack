use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

pub(crate) fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
pub(crate) fn dot() -> String {
    ".".into()
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Project {
    #[schemars(range(min = 1, max = 1))]
    #[ts(type = "1")]
    pub schema_version: u32,
    pub name: String,
    #[serde(default)]
    #[ts(as = "Option<Source>", optional)]
    pub source: Source,
    #[serde(default)]
    #[ts(as = "Option<BTreeMap<String, Workload>>", optional)]
    pub services: BTreeMap<String, Workload>,
    #[serde(default)]
    #[ts(as = "Option<BTreeMap<String, Workload>>", optional)]
    pub jobs: BTreeMap<String, Workload>,
    #[serde(default)]
    #[ts(as = "Option<BTreeMap<String, Storage>>", optional)]
    pub storage: BTreeMap<String, Storage>,
    #[serde(default)]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub profiles: Vec<String>,
    #[serde(default)]
    #[ts(as = "Option<EnvironmentSelection>", optional)]
    pub environment: EnvironmentSelection,
    #[serde(default)]
    #[ts(as = "Option<WorktreePolicy>", optional)]
    pub worktree: WorktreePolicy,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "crate::host::HostConfig")]
    #[ts(optional, type = "HostConfig")]
    pub host: Option<crate::host::HostConfig>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "crate::routing::Routes")]
    #[ts(optional, type = "Routes")]
    pub routes: Option<crate::routing::Routes>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "crate::routing::OpenConfig")]
    #[ts(optional, type = "OpenConfig")]
    pub open: Option<crate::routing::OpenConfig>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "BTreeMap<String,crate::endpoint::HostBindingTarget>")]
    #[ts(optional, type = "{ [key in string]: HostBindingTarget }")]
    pub host_bindings: Option<BTreeMap<String, crate::endpoint::HostBindingTarget>>,
}

fn enabled() -> bool {
    true
}

/// Authored worktree policy; neither flag grants runtime admission or cleanup authority.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct WorktreePolicy {
    #[serde(default = "enabled")]
    #[ts(as = "Option<bool>", optional)]
    pub auto_branch: bool,
    #[serde(default = "enabled")]
    #[ts(as = "Option<bool>", optional)]
    pub inherit_local: bool,
}
impl Default for WorktreePolicy {
    fn default() -> Self {
        Self {
            auto_branch: true,
            inherit_local: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Source {
    #[serde(default = "dot")]
    #[ts(as = "Option<String>", optional)]
    pub root: String,
    #[serde(default)]
    #[ts(as = "Option<SourceMode>", optional)]
    pub mode: SourceMode,
}
impl Default for Source {
    fn default() -> Self {
        Self {
            root: dot(),
            mode: SourceMode::HostMounted,
        }
    }
}
#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SourceMode {
    #[default]
    HostMounted,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentSelection {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    #[ts(optional, type = "string")]
    #[schemars(regex(pattern = "^[a-z0-9]+(?:-[a-z0-9]+)*$"))]
    pub default_overlay: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Workload {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    #[ts(optional, type = "string")]
    pub image: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Build")]
    #[ts(optional, type = "Build")]
    pub build: Option<Build>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Command")]
    #[ts(optional, type = "Command")]
    pub command: Option<Command>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    #[ts(optional, type = "string")]
    pub working_directory: Option<String>,
    #[serde(default)]
    #[ts(as = "Option<Vec<Mount>>", optional)]
    pub mounts: Vec<Mount>,
    #[serde(default)]
    #[ts(as = "Option<BTreeMap<String, EnvironmentValue>>", optional)]
    pub environment: BTreeMap<String, EnvironmentValue>,
    #[serde(default)]
    #[ts(as = "Option<Vec<Dependency>>", optional)]
    pub depends_on: Vec<Dependency>,
    #[serde(default)]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub profiles: Vec<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Readiness")]
    #[ts(optional, type = "Readiness")]
    pub readiness: Option<Readiness>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Build {
    pub context: String,
    #[serde(default = "dockerfile")]
    #[ts(as = "Option<String>", optional)]
    pub dockerfile: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    #[ts(optional, type = "string")]
    pub target: Option<String>,
}
fn dockerfile() -> String {
    "Dockerfile".into()
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(untagged, deny_unknown_fields)]
pub enum Command {
    Exec {
        #[schemars(length(min = 1))]
        exec: Vec<String>,
    },
    Shell {
        shell: String,
    },
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(untagged, deny_unknown_fields)]
pub enum EnvironmentValue {
    Literal {
        literal: String,
    },
    Default {
        default: String,
    },
    Reference {
        #[schemars(regex(pattern = "^[A-Z_][A-Z0-9_]*$"))]
        env_ref: String,
    },
    Unset {
        unset: True,
    },
    Endpoint {
        endpoint: crate::endpoint::EndpointReference,
    },
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(try_from = "bool", into = "bool")]
#[schemars(with = "bool", extend("const" = true))]
#[ts(type = "true")]
pub struct True;
impl TryFrom<bool> for True {
    type Error = &'static str;
    fn try_from(value: bool) -> Result<Self, Self::Error> {
        if value {
            Ok(Self)
        } else {
            Err("expected true")
        }
    }
}
impl From<True> for bool {
    fn from(_: True) -> Self {
        true
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Storage {
    pub kind: StorageKind,
    pub scope: StorageScope,
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum StorageKind {
    Persistent,
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum StorageScope {
    Worktree,
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(untagged, deny_unknown_fields)]
pub enum Mount {
    Source {
        source: String,
        target: String,
        access: Access,
    },
    Storage {
        storage: String,
        target: String,
        access: Access,
    },
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
pub enum Access {
    ReadOnly,
    ReadWrite,
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(untagged, deny_unknown_fields)]
pub enum Dependency {
    Service {
        service: String,
        condition: ServiceCondition,
    },
    Job {
        job: String,
        condition: JobCondition,
    },
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ServiceCondition {
    Started,
    Ready,
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum JobCondition {
    Completed,
}
impl Dependency {
    pub fn name(&self) -> &str {
        match self {
            Self::Service { service, .. } => service,
            Self::Job { job, .. } => job,
        }
    }
}
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Readiness {
    Exec {
        command: Command,
        interval: String,
        timeout: String,
        #[schemars(range(min = 1, max = 4294967295_u64))]
        retries: u32,
    },
    Http {
        #[schemars(range(min = 1, max = 65535))]
        port: u16,
        path: String,
        interval: String,
        timeout: String,
        #[schemars(range(min = 1, max = 4294967295_u64))]
        retries: u32,
    },
    Tcp {
        #[schemars(range(min = 1, max = 65535))]
        port: u16,
        interval: String,
        timeout: String,
        #[schemars(range(min = 1, max = 4294967295_u64))]
        retries: u32,
    },
}

#[derive(Debug, Clone, Serialize, JsonSchema, TS)]
pub struct Plan {
    #[ts(type = "1")]
    pub plan_version: u32,
    pub name: String,
    pub source: Source,
    pub environment: EnvironmentSelection,
    pub worktree: WorktreePolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "HostConfig")]
    pub host: Option<crate::host::HostConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Routes")]
    pub routes: Option<crate::routing::Routes>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "OpenConfig")]
    pub open: Option<crate::routing::OpenConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "{ [key in string]: HostBindingTarget }")]
    pub host_bindings: Option<BTreeMap<String, crate::endpoint::HostBindingTarget>>,

    pub selected_profiles: Vec<String>,
    pub storage: BTreeMap<String, Storage>,
    pub services: BTreeMap<String, Workload>,
    pub jobs: BTreeMap<String, Workload>,
}
