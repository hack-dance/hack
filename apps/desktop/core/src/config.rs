//! Versioned project config contract. Config subprocess errors never surface
//! unstructured output. Drafts travel on stdin and stay in memory.

use std::{collections::BTreeMap, path::Path, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::runner::{CliRunner, RunError, parse_schema_result};

pub const SCHEMA: &str = "hack.config.v1";

#[derive(Clone, Default, Deserialize)]
pub struct ConfigReport {
    pub state: ConfigState,
    pub project: Value,
    pub services: Vec<ConfigService>,
    pub layers: Vec<ConfigLayer>,
    pub env: Vec<EnvRow>,
    pub issues: Vec<ConfigIssue>,
    pub checkout: Option<String>,
    pub branch: Option<String>,
    pub overlay: Option<String>,
    pub default_overlay: Option<String>,
    pub overlays: Vec<String>,
    pub writable: bool,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigState {
    Ready,
    Invalid,
    #[default]
    Missing,
}

#[derive(Clone, Deserialize)]
pub struct ConfigLayer {
    pub id: String,
    pub file: String,
    pub kind: String,
    pub ownership: String,
    pub active: bool,
    pub writable: bool,
    pub revision: String,
    pub exists: bool,
    pub source: Option<String>,
    pub hidden: bool,
    pub source_writable: bool,
    pub inherited: Option<bool>,
    pub overlay: Option<String>,
}

impl ConfigLayer {
    pub fn name(&self) -> &str {
        Path::new(&self.file)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&self.file)
    }

    pub fn chip(&self) -> &str {
        if !self.active {
            "–"
        } else {
            self.overlay
                .as_deref()
                .map_or(&self.id, |_| match self.id.as_bytes().first() {
                    Some(b'3') => "3a",
                    Some(b'4') => "4a",
                    _ => "5a",
                })
        }
    }
}

impl ConfigReport {
    pub fn revisions(&self) -> BTreeMap<String, String> {
        self.layers
            .iter()
            .map(|layer| (layer.id.clone(), layer.revision.clone()))
            .collect()
    }

    pub fn layer(&self, id: &str) -> Option<&ConfigLayer> {
        self.layers.iter().find(|layer| layer.id == id)
    }

    /// Retain source order. The last assignment wins by layer, then by scope
    /// within the layer, including an explicit unset.
    pub fn env_for(&self, scope: &str) -> Vec<EnvRow> {
        let mut result: Vec<EnvRow> = Vec::new();
        for entry in self
            .env
            .iter()
            .filter(|entry| entry.scope == "global" || entry.scope == scope)
        {
            let mut scoped = entry.clone();
            for cell in &mut scoped.values {
                cell.scope.clone_from(&entry.scope);
            }
            if let Some(row) = result.iter_mut().find(|row| row.key == entry.key) {
                row.values.extend(scoped.values);
            } else {
                result.push(scoped);
            }
        }
        for row in &mut result {
            row.values.sort_by_key(|cell| {
                (
                    self.layers
                        .iter()
                        .position(|layer| layer.id == cell.layer)
                        .unwrap_or(usize::MAX),
                    cell.scope != "global",
                )
            });
            if let Some(cell) = row.values.last() {
                row.scope.clone_from(&cell.scope);
            }
            row.winning = row
                .values
                .last()
                .filter(|cell| !cell.unset)
                .map(|cell| cell.layer.clone());
        }
        result
    }
}

#[derive(Clone, Deserialize)]
pub struct ConfigService {
    pub name: String,
    pub image: Option<String>,
    pub ports: Vec<Value>,
    pub depends_on: Vec<String>,
    pub routes: Vec<ConfigRoute>,
    pub route_edit: Option<RouteEdit>,
    #[serde(default)]
    pub source_fields: Vec<String>,
}

#[derive(Clone, Deserialize)]
pub struct ConfigRoute {
    pub host: String,
    pub port: Option<u16>,
    pub tls: bool,
    pub from: Vec<String>,
}

#[derive(Clone, Deserialize)]
pub struct RouteEdit {
    pub sites: String,
    pub port: Option<u16>,
}

#[derive(Clone, Deserialize)]
pub struct EnvRow {
    pub key: String,
    pub scope: String,
    pub values: Vec<EnvCell>,
    pub winning: Option<String>,
}

#[derive(Clone, Deserialize)]
pub struct EnvCell {
    pub layer: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub unset: bool,
    pub secret: bool,
    pub value: Option<Value>,
}

impl EnvCell {
    pub fn label(&self) -> String {
        if self.secret {
            "secret · set".into()
        } else if self.unset {
            "unset".into()
        } else {
            self.value.as_ref().map_or_else(String::new, scalar_label)
        }
    }
}

pub fn scalar_label(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), ToOwned::to_owned)
}

#[derive(Clone, Deserialize)]
pub struct ConfigIssue {
    pub layer: Option<String>,
    pub path: Vec<String>,
    pub line: Option<usize>,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Default, Deserialize)]
pub struct ConfigValidation {
    pub valid: bool,
    pub issues: Vec<ConfigIssue>,
    pub previews: BTreeMap<String, Option<String>>,
}

#[derive(Clone, Deserialize)]
pub struct ConfigSaved {
    pub changed: Vec<String>,
    pub restart_offered: bool,
}

#[derive(Clone)]
pub struct ConfigError {
    pub code: String,
    pub message: String,
    pub issues: Vec<ConfigIssue>,
    pub changed: Vec<String>,
}

impl ConfigError {
    pub fn unavailable() -> Self {
        Self {
            code: "E_UNAVAILABLE".into(),
            message:
                "Hack couldn’t read this project’s Config. Check the selected CLI and try again."
                    .into(),
            issues: Vec::new(),
            changed: Vec::new(),
        }
    }
}

#[derive(Clone, Default, PartialEq, Eq, Hash)]
pub struct ConfigTarget {
    pub branch: Option<String>,
    pub overlay: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct ConfigPatch {
    pub base: BTreeMap<String, String>,
    pub changes: Vec<ConfigChange>,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConfigChange {
    Project {
        layer: String,
        path: String,
        value: Value,
    },
    Route {
        layer: String,
        service: String,
        sites: String,
        port: String,
    },
    Service {
        layer: String,
        service: String,
        field: String,
        value: Value,
    },
    Env {
        layer: String,
        scope: String,
        key: String,
        value: Option<String>,
    },
    Source {
        layer: String,
        text: String,
    },
}

impl ConfigChange {
    pub fn layer(&self) -> &str {
        match self {
            Self::Project { layer, .. }
            | Self::Route { layer, .. }
            | Self::Service { layer, .. }
            | Self::Env { layer, .. }
            | Self::Source { layer, .. } => layer,
        }
    }
}

pub(crate) fn run_config<T: serde::de::DeserializeOwned>(
    runner: CliRunner,
    root: &Path,
    target: &ConfigTarget,
    command: &str,
    patch: Option<&ConfigPatch>,
) -> Result<T, ConfigError> {
    let mut args = vec!["config", command, "--json"];
    if let Some(branch) = &target.branch {
        args.extend(["--branch", branch]);
    }
    if let Some(overlay) = &target.overlay {
        args.extend(["--env", overlay]);
    }
    let runner = runner.with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1");
    let timeout = Duration::from_secs(15);
    let (stdout, _, code) = if let Some(patch) = patch {
        let input = serde_json::to_vec(patch).map_err(|_| ConfigError::unavailable())?;
        runner.run_raw_with_input(&args, Some(root), timeout, &input)
    } else {
        runner.run_raw(&args, Some(root), timeout)
    }
    .map_err(|_| ConfigError::unavailable())?;
    let envelope = parse_schema_result(&stdout, "", code, SCHEMA).map_err(|error| match error {
        RunError::Cli(error) => {
            let detail = error.detail.unwrap_or(Value::Null);
            ConfigError {
                code: error.code,
                message: error.message,
                issues: serde_json::from_value(detail["issues"].clone()).unwrap_or_default(),
                changed: serde_json::from_value(detail["changed"].clone()).unwrap_or_default(),
            }
        }
        _ => ConfigError::unavailable(),
    })?;
    serde_json::from_value(envelope).map_err(|_| ConfigError::unavailable())
}
