//! Durable startup intent is separate from observed application readiness.
use super::*;
use std::path::{Component, Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Startup {
    /// Explicit foreground ownership without guest relay artifacts or listeners.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) control_only: bool,
    pub(crate) guest_root: Option<(u64, u64)>,
    pub(crate) control_root: PathBuf,
    pub(crate) artifact: String,
    pub(crate) services: BTreeMap<String, Service>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Service {
    pub(crate) generation: String,
    pub(crate) bindings: BTreeMap<String, Binding>,
    pub(crate) phase: Phase,
    pub(crate) started_at: Option<String>,
}
/// The earlier experimental single-binding receipt is intentionally refused;
/// there is no default empty binding set or inferred migration authority.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub(crate) slot: u8,
    pub(crate) port: u16,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) aliases: Vec<String>,
    pub(crate) process: Option<super::super::lifecycle::RelayProcess>,
}
fn binding_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}
impl Service {
    fn bindings_valid(&self) -> bool {
        !self.bindings.is_empty()
            && self.bindings.len() <= 32
            && self.bindings.iter().all(|(name, binding)| {
                binding_name(name)
                    && binding.slot < 32
                    && binding.port != 0
                    && dependency_address(binding.slot, &binding.aliases).is_ok()
                    && binding.process.is_none_or(|p| {
                        p.pid > 1
                            && p.start > 0
                            && p.port == binding.port
                            && dependency_address(binding.slot, &binding.aliases).ok()
                                == Some(p.address)
                    })
            })
            && self
                .bindings
                .values()
                .map(|b| (dependency_address(b.slot, &b.aliases).ok(), b.port))
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == self.bindings.len()
            && self
                .bindings
                .values()
                .flat_map(|b| b.aliases.iter())
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == self
                    .bindings
                    .values()
                    .map(|b| b.aliases.len())
                    .sum::<usize>()
            && self
                .bindings
                .values()
                .map(|b| b.slot)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == self.bindings.len()
    }
    fn all_provisioned(&self) -> bool {
        self.bindings_valid() && self.bindings.values().all(|b| b.process.is_some())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    Prepared,
    ProvisionIntent,
    Provisioned,
    Released,
}
impl Startup {
    pub(super) fn valid(&self, receipt: &Receipt) -> bool {
        self.guest_root.is_none_or(|(_, inode)| inode != 0)
            && self.control_root.is_absolute()
            && self.control_root.as_os_str().len() < 80
            && self
                .control_root
                .components()
                .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
            && hex(&self.artifact, 64)
            && (if self.control_only {
                self.services.is_empty() && self.guest_root.is_none()
            } else {
                !self.services.is_empty()
            })
            && self.services.len() <= 32
            && self.services.iter().all(|(name, service)| {
                receipt.resources.contains_key(&format!("container:{name}"))
                    && hex(&service.generation, 32)
                    && service.bindings_valid()
                    && match service.phase {
                        Phase::Prepared => {
                            service.started_at.is_none()
                                && service.bindings.values().all(|b| b.process.is_none())
                        }
                        Phase::ProvisionIntent => service
                            .started_at
                            .as_ref()
                            .is_some_and(|s| valid_started(s)),
                        Phase::Provisioned | Phase::Released => {
                            service
                                .started_at
                                .as_ref()
                                .is_some_and(|s| valid_started(s))
                                && service.all_provisioned()
                        }
                    }
            })
            && self
                .services
                .values()
                .flat_map(|s| s.bindings.values().map(|b| b.slot))
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == self
                    .services
                    .values()
                    .map(|s| s.bindings.len())
                    .sum::<usize>()
            && self
                .services
                .values()
                .map(|s| s.bindings.len())
                .sum::<usize>()
                <= 32
    }
}
pub(super) fn valid_started(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with("0001-")
        && !value.bytes().any(|b| b.is_ascii_control())
}
pub(super) trait Driver {
    fn check_cancelled(&self) -> Result<(), CandidateError> {
        Ok(())
    }
    fn validate_inputs(
        &self,
        inputs: &project::inputs::ExecutionInputs,
    ) -> Result<(), CandidateError>;
    fn verify(&mut self, engine: &Engine<'_>, receipt: &Receipt) -> Result<(), CandidateError>;
    fn prepare(
        &mut self,
        engine: &Engine<'_>,
        receipt: &mut Receipt,
        root: &Path,
        configs: &mut BTreeMap<String, Value>,
    ) -> Result<(), CandidateError>;
    fn started(
        &mut self,
        engine: &Engine<'_>,
        receipt: &mut Receipt,
        root: &Path,
        config: &Value,
        service: &str,
    ) -> Result<(), CandidateError>;
}

/// Named routes rely on the engine-owned hosts file and the image resolver policy.
/// Project mounts must not replace either file or an enclosing directory.
fn shadows_name_resolution(target: &str) -> bool {
    let target = Path::new(target);
    ["/etc/hosts", "/etc/nsswitch.conf"].iter().any(|reserved| {
        let reserved = Path::new(reserved);
        target.starts_with(reserved) || reserved.starts_with(target)
    })
}

/// Wrap the already composed environment launcher, never its inner application.
/// The directory and executable are immutable read-only mounts owned by this run.
pub(super) fn attach(
    config: &mut Value,
    service: &Service,
    directory: &str,
    executable: &str,
) -> Result<(), CandidateError> {
    launcher::identity(config)?;
    if config["HostConfig"]["Init"] != true
        || !hex(&service.generation, 32)
        || !service.bindings_valid()
    {
        return Err(error(
            "graph_startup",
            "Startup requires the owned init and a valid generation.",
        ));
    }
    let aliases: BTreeMap<_, _> = service
        .bindings
        .values()
        .flat_map(|binding| {
            binding
                .aliases
                .iter()
                .map(move |name| (name.clone(), binding))
        })
        .collect();
    let declared = match &config["HostConfig"]["ExtraHosts"] {
        Value::Null => Vec::new(),
        Value::Array(values) => values
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or_else(dependency_hosts::refused)
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(dependency_hosts::refused()),
    };
    let expected: Vec<_> = aliases
        .keys()
        .map(|name| format!("{name}:host-gateway"))
        .collect();
    if declared != expected {
        return Err(dependency_hosts::refused());
    }
    if !aliases.is_empty() {
        config["HostConfig"]["ExtraHosts"] = json!(
            aliases
                .iter()
                .map(|(name, binding)| {
                    dependency_address(binding.slot, &binding.aliases)
                        .map(|address| format!("{name}:{address}"))
                })
                .collect::<Result<Vec<_>, _>>()?
        );
    }
    if service.bindings.values().any(|binding| binding.port < 1024) {
        let mode = config["HostConfig"]["NetworkMode"]
            .as_str()
            .ok_or_else(dependency_hosts::refused)?;
        let owned_network = mode.starts_with("hkg-")
            && config["NetworkingConfig"]["EndpointsConfig"]
                .get(mode)
                .is_some();
        if (mode != "none" && !owned_network)
            || config["HostConfig"]["CapDrop"] != json!(["ALL"])
            || !config["HostConfig"]["Sysctls"].is_null()
        {
            return Err(dependency_hosts::refused());
        }
        // Docker applies this only inside the isolated container network namespace.
        // The helper retains the application's numeric UID and all capabilities stay dropped.
        config["HostConfig"]["Sysctls"] = json!({"net.ipv4.ip_unprivileged_port_start":"0"});
    }
    for mount in config["HostConfig"]["Mounts"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let path = mount["Target"].as_str().unwrap_or("");
        if (!aliases.is_empty() && shadows_name_resolution(path))
            || ["/", "/run"].contains(&path)
            || path.starts_with("/run/hack-relay-guest/")
            || path == "/run/hack-relay-guest"
            || path == "/run/hack-startup"
            || path.starts_with("/run/hack-startup/")
            || path == "/run/hack-dependencies"
            || path.starts_with("/run/hack-dependencies/")
        {
            return Err(error(
                "graph_startup",
                "A mount overlaps reserved dependency paths.",
            ));
        }
    }
    let wrap = |mode: &str, argv: Vec<Value>| {
        let mut result = vec![
            json!("/run/hack-relay-guest"),
            json!(mode),
            json!(service.generation),
            json!("--"),
        ];
        result.extend(argv);
        result
    };
    if config["Healthcheck"]["Test"][0] == "CMD" {
        let mut health = vec![json!("CMD")];
        health.extend(wrap(
            "--check-release",
            config["Healthcheck"]["Test"]
                .as_array()
                .ok_or_else(|| error("graph_startup", "Invalid health argv."))?[1..]
                .to_vec(),
        ));
        config["Healthcheck"]["Test"] = json!(health);
    }
    let mut argv = config["Entrypoint"]
        .as_array()
        .ok_or_else(|| error("graph_startup", "Missing application entrypoint."))?
        .clone();
    argv.extend(config["Cmd"].as_array().into_iter().flatten().cloned());
    config["Entrypoint"] = json!(wrap("--await-release", argv));
    config["Cmd"] = json!([]);
    let mounts = config["HostConfig"]["Mounts"]
        .as_array_mut()
        .ok_or_else(|| error("graph_startup", "Missing mounts."))?;
    let fixed = [
        (directory.to_owned(), "/run/hack-startup".to_owned()),
        (executable.to_owned(), "/run/hack-relay-guest".to_owned()),
    ];
    let sockets = service.bindings.values().map(|binding| {
        let path = format!("/run/hack-dependencies/dependency-{:02}.sock", binding.slot);
        (path.clone(), path)
    });
    for (source, target) in fixed.into_iter().chain(sockets) {
        mounts.push(json!({"Type":"bind","Source":source,"Target":target,"ReadOnly":true,"BindOptions":{"Propagation":"rprivate"}}));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod runtime;
#[cfg(target_os = "macos")]
pub use runtime::{Dependency, HostRelayRuntime};

pub(super) fn guest_directory(run: &str, generation: &str) -> String {
    format!("/storage/hack-graph-startup/{run}/{generation}")
}
pub(super) fn guest_executable(run: &str) -> String {
    format!("/storage/hack-graph-startup/{run}/helper")
}

#[cfg(test)]
mod tests;

mod cleanup;
pub(super) use cleanup::{absent as verify_cleanup, apply as cleanup_guest};

#[cfg(all(test, target_os = "macos"))]
mod native_test;
