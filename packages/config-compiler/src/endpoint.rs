//! Offline endpoint intent and logical host bindings. Addresses needing backend ownership remain symbolic.
use crate::{Diagnostic, diagnostic_at, json::child, local, model, validate};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
pub enum EndpointProtocol {
    Http,
    Https,
    Tcp,
}

/// References select a named public route, a guest service, or a locally provisioned binding.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EndpointReference {
    Route {
        name: String,
    },
    Service {
        name: String,
        #[schemars(range(min = 1, max = 65535))]
        port: u16,
        protocol: EndpointProtocol,
    },
    HostBinding {
        #[schemars(
            length(min = 1, max = 63),
            regex(pattern = "^[a-z0-9]+(?:-[a-z0-9]+)*$")
        )]
        name: String,
    },
}

/// `host` is the host loopback/gateway intent; an external hostname is a literal address.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostBindingTarget {
    Host {
        #[schemars(range(min = 1, max = 65535))]
        port: u16,
        protocol: EndpointProtocol,
    },
    External {
        #[schemars(length(min = 1, max = 253))]
        hostname: String,
        #[schemars(range(min = 1, max = 65535))]
        port: u16,
        protocol: EndpointProtocol,
    },
}

#[derive(Debug, Clone, Copy, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HostBindingOrigin {
    Project,
    PrimaryLocal,
    CheckoutLocal,
}

#[derive(Debug, Clone, Serialize, JsonSchema, TS)]
pub struct ResolvedHostBinding {
    pub target: HostBindingTarget,
    pub origin: HostBindingOrigin,
}

#[derive(Debug, Serialize, JsonSchema, TS)]
pub struct HostBindingResolution {
    pub bindings: BTreeMap<String, ResolvedHostBinding>,
    pub removed: BTreeMap<String, HostBindingOrigin>,
}

#[derive(Debug, Clone, Copy, Serialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum EndpointContext {
    Workload,
    Host,
}

/// This is an execution-independent plan, never a claim that an address is reachable.
#[derive(Debug, Serialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EndpointTarget {
    Route {
        origin: String,
    },
    Service {
        name: String,
        port: u16,
        protocol: EndpointProtocol,
    },
    Host {
        context: EndpointContext,
        port: u16,
        protocol: EndpointProtocol,
    },
    External {
        hostname: String,
        port: u16,
        protocol: EndpointProtocol,
    },
}

pub(crate) struct EndpointUse {
    reference: EndpointReference,
    pointer: String,
    workload: Option<String>,
}

/// Retain every authored reference before profile pruning, with authored diagnostic positions.
pub(crate) fn uses(project: &model::Project) -> Vec<EndpointUse> {
    let mut result = Vec::new();
    for (kind, workloads) in [("services", &project.services), ("jobs", &project.jobs)] {
        for (name, workload) in workloads {
            let pointer = child(&format!("/{kind}"), name);
            collect(&mut result, &workload.environment, &pointer, Some(name));
        }
    }
    if let Some(host) = &project.host {
        for entry in host.entries() {
            collect(&mut result, entry.environment, &entry.pointer, None);
        }
    }
    result
}
fn collect(
    result: &mut Vec<EndpointUse>,
    environment: &BTreeMap<String, model::EnvironmentValue>,
    pointer: &str,
    workload: Option<&String>,
) {
    for (key, directive) in environment {
        if let model::EnvironmentValue::Endpoint { endpoint } = directive {
            result.push(EndpointUse {
                reference: endpoint.clone(),
                pointer: format!("{}/endpoint", child(&format!("{pointer}/environment"), key)),
                workload: workload.cloned(),
            });
        }
    }
}
pub(crate) fn binding_name(value: &str) -> bool {
    value.len() <= 63 && validate::overlay_name(value)
}
pub(crate) fn binding_name_schema() -> serde_json::Value {
    serde_json::json!({"type":"string","minLength":1,"maxLength":63,"pattern":"^[a-z0-9]+(?:-[a-z0-9]+)*$"})
}
pub(crate) fn validate_binding(
    name: &str,
    target: Option<&HostBindingTarget>,
    pointer: &str,
    at: &dyn Fn(&str, &str) -> Diagnostic,
) -> Result<(), Diagnostic> {
    if !binding_name(name) {
        return Err(at("invalid_name", pointer));
    }
    if let Some(target) = target {
        let port = match target {
            HostBindingTarget::Host { port, .. } => port,
            HostBindingTarget::External { hostname, port, .. } => {
                if !crate::routing::hostname(hostname) {
                    return Err(at("invalid_host_binding", &child(pointer, "hostname")));
                }
                port
            }
        };
        if *port == 0 {
            return Err(at("invalid_host_binding", &child(pointer, "port")));
        }
    }
    Ok(())
}
pub(crate) fn validate_project(
    project: &model::Project,
    selected: &[String],
    at: &dyn Fn(&str, &str) -> Diagnostic,
) -> Result<(), Diagnostic> {
    if let Some(bindings) = &project.host_bindings {
        for (name, target) in bindings {
            validate_binding(name, Some(target), &child("/host_bindings", name), at)?;
        }
    }
    for usage in uses(project) {
        let (name, port, target) = match &usage.reference {
            EndpointReference::HostBinding { name } => {
                if !binding_name(name) {
                    return Err(at("invalid_endpoint", &child(&usage.pointer, "name")));
                }
                continue;
            }
            EndpointReference::Service { name, port, .. } => (name, Some(*port), Some(name)),
            EndpointReference::Route { name } => {
                let route = project
                    .routes
                    .as_ref()
                    .and_then(|routes| routes.http.get(name));
                (name, None, route.map(|r| &r.service))
            }
        };
        if !validate::name(name) || port == Some(0) {
            return Err(at("invalid_endpoint", &usage.pointer));
        }
        let service = target
            .and_then(|name| project.services.get(name))
            .ok_or_else(|| at("unknown_endpoint_target", &usage.pointer))?;
        let source_active = usage
            .workload
            .as_ref()
            .and_then(|name| {
                project
                    .services
                    .get(name)
                    .or_else(|| project.jobs.get(name))
            })
            .is_none_or(|source| {
                source.profiles.is_empty() || source.profiles.iter().any(|p| selected.contains(p))
            });
        let target_active =
            service.profiles.is_empty() || service.profiles.iter().any(|p| selected.contains(p));
        if source_active && !target_active {
            return Err(at("inactive_endpoint_target", &usage.pointer));
        }
        if matches!(&usage.reference, EndpointReference::Service { .. })
            && let Some(source) = usage.workload.as_ref().and_then(|name| {
                project
                    .services
                    .get(name)
                    .or_else(|| project.jobs.get(name))
            })
            && !crate::network::share_network(source, service)
        {
            return Err(at("disconnected_endpoint_target", &usage.pointer));
        }
    }
    Ok(())
}

/// Merge only verified local inputs supplied by the adapter; no filesystem lookup occurs here.
pub(crate) fn resolve_bindings(
    compiled: &crate::Compiled,
    primary: Option<&local::ParsedLocal>,
    checkout: Option<&local::ParsedLocal>,
) -> Result<Option<HostBindingResolution>, local::ResolveDiagnostic> {
    let project = &compiled.plan.host_bindings;
    let primary = primary.filter(|_| compiled.plan.worktree.inherit_local);
    if project.is_none()
        && [primary, checkout]
            .iter()
            .all(|input| input.is_none_or(|input| input.config.host_bindings.is_none()))
    {
        check_bindings(compiled, None, &BTreeMap::new())?;
        return Ok(None);
    }
    let mut output = HostBindingResolution {
        bindings: BTreeMap::new(),
        removed: BTreeMap::new(),
    };
    let mut removed_locations = BTreeMap::new();
    let mut remaining = crate::environment::MAX_PLAN_OUTPUT_BYTES;
    let at = |code: &str, pointer: &str| {
        local::with_role(
            local::DocumentRole::Project,
            diagnostic_at(&compiled.positions, code, pointer),
        )
    };
    charge(&mut remaining, &compiled.plan, &at)?;
    charge(&mut remaining, &compiled.declared_workloads, &at)?;
    remaining = remaining
        .checked_sub(4096)
        .ok_or_else(|| at("plan_too_large", "/host_bindings"))?;
    if let Some(bindings) = project {
        for (name, target) in bindings {
            charge(&mut remaining, &(name, target, "project"), &at)?;
            output.bindings.insert(
                name.clone(),
                ResolvedHostBinding {
                    target: target.clone(),
                    origin: HostBindingOrigin::Project,
                },
            );
        }
    }
    for (input, origin, role) in [
        (
            primary,
            HostBindingOrigin::PrimaryLocal,
            local::DocumentRole::PrimaryLocal,
        ),
        (
            checkout,
            HostBindingOrigin::CheckoutLocal,
            local::DocumentRole::CheckoutLocal,
        ),
    ] {
        if let Some(input) = input
            && let Some(bindings) = &input.config.host_bindings
        {
            let at = |code: &str, pointer: &str| {
                local::with_role(role, diagnostic_at(&input.positions, code, pointer))
            };
            for (name, target) in bindings {
                let pointer = child("/host_bindings", name);
                charge(&mut remaining, &(name, target, origin), &at)?;
                if let Some(target) = target {
                    output.bindings.insert(
                        name.clone(),
                        ResolvedHostBinding {
                            target: target.clone(),
                            origin,
                        },
                    );
                    output.removed.remove(name);
                    removed_locations.remove(name);
                } else {
                    output.bindings.remove(name);
                    output.removed.insert(name.clone(), origin);
                    removed_locations.insert(name.clone(), at("removed_host_binding", &pointer));
                }
            }
        }
    }
    check_bindings(compiled, Some(&output), &removed_locations)?;
    Ok(Some(output))
}
fn charge(
    remaining: &mut usize,
    value: &impl Serialize,
    at: &dyn Fn(&str, &str) -> local::ResolveDiagnostic,
) -> Result<(), local::ResolveDiagnostic> {
    let bytes = crate::environment::serialized_size(value)
        .map_err(|_| at("plan_too_large", "/host_bindings"))?;
    *remaining = remaining
        .checked_sub(bytes + 96)
        .ok_or_else(|| at("plan_too_large", "/host_bindings"))?;
    Ok(())
}
fn check_bindings(
    compiled: &crate::Compiled,
    output: Option<&HostBindingResolution>,
    removed: &BTreeMap<String, local::ResolveDiagnostic>,
) -> Result<(), local::ResolveDiagnostic> {
    for usage in &compiled.endpoint_uses {
        if let EndpointReference::HostBinding { name } = &usage.reference
            && !output.is_some_and(|output| output.bindings.contains_key(name))
        {
            return Err(removed.get(name).cloned().unwrap_or_else(|| {
                local::with_role(
                    local::DocumentRole::Project,
                    diagnostic_at(&compiled.positions, "unknown_host_binding", &usage.pointer),
                )
            }));
        }
    }
    Ok(())
}

pub(crate) fn target(
    reference: &EndpointReference,
    context: EndpointContext,
    resolved: &local::Resolved,
) -> Result<EndpointTarget, &'static str> {
    match reference {
        EndpointReference::Route { name } => {
            let route = resolved
                .routing_resolution
                .as_ref()
                .and_then(|routes| routes.routes.get(name))
                .ok_or("unknown_endpoint_target")?;
            Ok(EndpointTarget::Route {
                origin: route.origin.clone(),
            })
        }
        EndpointReference::Service {
            name,
            port,
            protocol,
        } => {
            if matches!(context, EndpointContext::Host) {
                return Err("unsupported_endpoint_context");
            }
            Ok(EndpointTarget::Service {
                name: name.clone(),
                port: *port,
                protocol: protocol.clone(),
            })
        }
        EndpointReference::HostBinding { name } => {
            let binding = resolved
                .host_binding_resolution
                .as_ref()
                .and_then(|bindings| bindings.bindings.get(name))
                .ok_or("unknown_host_binding")?;
            Ok(match &binding.target {
                HostBindingTarget::Host { port, protocol } => EndpointTarget::Host {
                    context,
                    port: *port,
                    protocol: protocol.clone(),
                },
                HostBindingTarget::External {
                    hostname,
                    port,
                    protocol,
                } => EndpointTarget::External {
                    hostname: hostname.clone(),
                    port: *port,
                    protocol: protocol.clone(),
                },
            })
        }
    }
}
