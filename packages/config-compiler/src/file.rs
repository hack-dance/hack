//! Symbolic file grants only. This module never reads files or resolves private values.
use crate::{Diagnostic, environment, json, local, model, validate};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

type At<'a> = dyn Fn(&str, &str) -> Diagnostic + 'a;

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct FileConfig {
    pub file: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(untagged, deny_unknown_fields)]
pub enum FileSecret {
    File { file: String },
    Managed { env_ref: String },
}

pub(crate) fn default_mode() -> String {
    "0444".into()
}

fn normalize_file(file: &mut String, pointer: &str, at: &At<'_>) -> Result<(), Diagnostic> {
    *file = validate::relative(file)
        .filter(|path| path != ".")
        .ok_or_else(|| at("invalid_path", pointer))?;
    Ok(())
}

pub(crate) fn normalize_sources(
    configs: &mut BTreeMap<String, FileConfig>,
    secrets: &mut BTreeMap<String, FileSecret>,
    at: &At<'_>,
) -> Result<(), Diagnostic> {
    for (name, config) in configs {
        let pointer = json::child("/configs", name);
        if !validate::name(name) {
            return Err(at("invalid_name", &pointer));
        }
        normalize_file(&mut config.file, &json::child(&pointer, "file"), at)?;
    }
    for (name, secret) in secrets {
        let pointer = json::child("/secrets", name);
        if !validate::name(name) {
            return Err(at("invalid_name", &pointer));
        }
        match secret {
            FileSecret::File { file } => normalize_file(file, &json::child(&pointer, "file"), at)?,
            FileSecret::Managed { env_ref } => {
                if !validate::managed_key(env_ref) {
                    return Err(at(
                        "invalid_environment_key",
                        &json::child(&pointer, "env_ref"),
                    ));
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Config,
    Secret,
}

struct Grant<'a> {
    kind: FileKind,
    name: &'a str,
    target: &'a str,
    access: &'a model::Access,
    mode: &'a str,
    uid: Option<u32>,
    gid: Option<u32>,
}

fn grant(mount: &model::Mount) -> Option<Grant<'_>> {
    let (kind, name, target, access, mode, uid, gid) = match mount {
        model::Mount::Config {
            config,
            target,
            access,
            mode,
            uid,
            gid,
        } => (FileKind::Config, config, target, access, mode, *uid, *gid),
        model::Mount::Secret {
            secret,
            target,
            access,
            mode,
            uid,
            gid,
        } => (FileKind::Secret, secret, target, access, mode, *uid, *gid),
        _ => return None,
    };
    Some(Grant {
        kind,
        name,
        target,
        access,
        mode,
        uid,
        gid,
    })
}

fn target(mount: &model::Mount) -> &str {
    match mount {
        model::Mount::Source { target, .. }
        | model::Mount::Storage { target, .. }
        | model::Mount::Config { target, .. }
        | model::Mount::Secret { target, .. } => target,
    }
}

fn contains(parent: &str, child: &str) -> bool {
    parent == "/"
        || child
            .strip_prefix(parent)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

pub(crate) fn validate_grants(
    workload: &model::Workload,
    pointer: &str,
    configs: &BTreeMap<String, FileConfig>,
    secrets: &BTreeMap<String, FileSecret>,
    at: &At<'_>,
) -> Result<(), Diagnostic> {
    for (index, mount) in workload.mounts.iter().enumerate() {
        let Some(grant) = grant(mount) else { continue };
        let pointer = format!("{pointer}/mounts/{index}");
        let (exists, key) = match grant.kind {
            FileKind::Config => (configs.contains_key(grant.name), "config"),
            FileKind::Secret => (secrets.contains_key(grant.name), "secret"),
        };
        if !exists {
            return Err(at("unknown_file_input", &json::child(&pointer, key)));
        }
        let mode = grant.mode.as_bytes();
        if mode.len() != 4
            || mode[0] != b'0'
            || mode[1..].iter().any(|byte| !matches!(byte, b'0'..=b'7'))
        {
            return Err(at("invalid_file_mode", &json::child(&pointer, "mode")));
        }
        if grant.target == "/"
            || workload.mounts.iter().enumerate().any(|(other, mount)| {
                other != index
                    && (contains(grant.target, target(mount))
                        || contains(target(mount), grant.target))
            })
        {
            return Err(at("file_mount_overlap", &json::child(&pointer, "target")));
        }
    }
    Ok(())
}

#[derive(Debug, Serialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileBindingSource {
    File {
        file: String,
    },
    Managed {
        key: String,
        scope: String,
        secret: bool,
    },
}

/// A grant is separate from env delivery: authored env unset cannot grant or revoke it.
#[derive(Debug, Serialize, JsonSchema, TS)]
pub struct FileBinding {
    pub kind: FileKind,
    pub name: String,
    pub source: FileBindingSource,
    pub target: String,
    pub access: model::Access,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub uid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub gid: Option<u32>,
}

#[derive(Debug, Serialize, JsonSchema, TS)]
pub struct FilePlan {
    #[ts(type = "1")]
    pub plan_version: u32,
    pub complete: bool,
    pub workloads: BTreeMap<String, Vec<FileBinding>>,
    pub diagnostics: Vec<local::ResolveDiagnostic>,
}

pub(crate) fn bind(
    resolved: &local::Resolved,
    metadata: &environment::EnvMetadata,
) -> Result<Option<FilePlan>, local::ResolveDiagnostic> {
    let plan = &resolved.compiled.plan;
    if plan.configs.is_empty() && plan.secrets.is_empty() {
        return Ok(None);
    }
    let mut output = FilePlan {
        plan_version: 1,
        complete: true,
        workloads: BTreeMap::new(),
        diagnostics: Vec::new(),
    };
    let mut remaining = environment::MAX_PLAN_OUTPUT_BYTES;
    for (namespace, workloads) in [("services", &plan.services), ("jobs", &plan.jobs)] {
        for (name, workload) in workloads {
            let mut bindings = Vec::new();
            for (index, mount) in workload.mounts.iter().enumerate() {
                let Some(grant) = grant(mount) else { continue };
                let source = match grant.kind {
                    FileKind::Config => {
                        plan.configs
                            .get(grant.name)
                            .map(|config| FileBindingSource::File {
                                file: config.file.clone(),
                            })
                    }
                    FileKind::Secret => match plan.secrets.get(grant.name) {
                        Some(FileSecret::File { file }) => {
                            Some(FileBindingSource::File { file: file.clone() })
                        }
                        Some(FileSecret::Managed { env_ref }) => metadata
                            .workloads
                            .get(name)
                            .and_then(|baseline| baseline.get(env_ref))
                            .map(|binding| FileBindingSource::Managed {
                                key: env_ref.clone(),
                                scope: binding.scope.clone(),
                                secret: binding.secret,
                            }),
                        None => None,
                    },
                };
                let Some(source) = source else {
                    let diagnostic = local::with_role(
                        local::DocumentRole::Project,
                        crate::diagnostic_at(
                            &resolved.compiled.positions,
                            "missing_env_reference",
                            &format!(
                                "{}/mounts/{index}/secret",
                                json::child(&format!("/{namespace}"), name)
                            ),
                        ),
                    );
                    charge(&mut remaining, &diagnostic, resolved)?;
                    output.diagnostics.push(diagnostic);
                    output.complete = false;
                    continue;
                };
                let binding = FileBinding {
                    kind: grant.kind,
                    name: grant.name.into(),
                    source,
                    target: grant.target.into(),
                    access: grant.access.clone(),
                    mode: grant.mode.into(),
                    uid: grant.uid,
                    gid: grant.gid,
                };
                charge(&mut remaining, &binding, resolved)?;
                bindings.push(binding);
            }
            if !bindings.is_empty() {
                output.workloads.insert(name.clone(), bindings);
            }
        }
    }
    Ok(Some(output))
}

fn charge(
    remaining: &mut usize,
    value: &impl Serialize,
    resolved: &local::Resolved,
) -> Result<(), local::ResolveDiagnostic> {
    let too_large = || {
        local::with_role(
            local::DocumentRole::Project,
            crate::diagnostic_at(&resolved.compiled.positions, "plan_too_large", ""),
        )
    };
    let size = environment::serialized_size(value).map_err(|()| too_large())?;
    *remaining = remaining.checked_sub(size).ok_or_else(too_large)?;
    Ok(())
}
