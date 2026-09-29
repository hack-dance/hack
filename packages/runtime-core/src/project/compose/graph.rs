use super::super::*;
use std::collections::BTreeSet;

pub(super) fn validate(
    services: &BTreeMap<String, ServicePlan>,
    networks: &BTreeMap<String, NetworkPlan>,
    profiles: &[String],
    diagnostics: &mut Vec<Diagnostic>,
) {
    let known_profiles: BTreeSet<_> = services.values().flat_map(|s| s.profiles.iter()).collect();
    for profile in profiles {
        if !known_profiles.contains(profile) {
            diagnostics.push(Diagnostic::error(
                "unknown_profile",
                "profiles",
                "A requested profile is not declared by any service.",
            ));
        }
    }
    if !services.values().any(|s| s.active) {
        diagnostics.push(Diagnostic::error(
            "empty_active_graph",
            "services",
            "No service is active for the selected profiles.",
        ));
    }
    let mut publications = BTreeSet::new();
    for (name, service) in services {
        let field = format!("services.{name}");
        for network in &service.networks {
            if !networks.contains_key(network) {
                diagnostics.push(Diagnostic::error(
                    "undeclared_network",
                    &field,
                    "Service references an undeclared project network.",
                ));
            }
        }
        for (dependency, condition) in &service.dependencies {
            let Some(target) = services.get(dependency) else {
                diagnostics.push(Diagnostic::error(
                    "missing_dependency",
                    &field,
                    "Dependency service does not exist.",
                ));
                continue;
            };
            if service.active && !target.active {
                diagnostics.push(Diagnostic::error(
                    "inactive_dependency",
                    &field,
                    "An active service depends on a service disabled by the selected profiles.",
                ));
            }
            if condition.condition == "service_healthy"
                && !target
                    .healthcheck
                    .as_ref()
                    .is_some_and(|h| !h.disabled && (h.test.is_some() || h.native_http.is_some()))
            {
                diagnostics.push(Diagnostic::error("missing_healthcheck",&field,"A healthy dependency needs an explicit enabled healthcheck; image health defaults are not assumed."));
            }
            if condition.condition == "service_completed_successfully"
                && ["always", "unless-stopped"].contains(&target.restart.as_str())
            {
                diagnostics.push(Diagnostic::error(
                    "nonterminating_completion_dependency",
                    &field,
                    "A completion dependency cannot use an unconditional restart policy.",
                ));
            }
        }
        if service.active {
            for port in &service.ports {
                if let Some(published) = port.published {
                    if !publications.insert((
                        port.proposed_host_ip.clone(),
                        published,
                        port.protocol.clone(),
                    )) {
                        diagnostics.push(Diagnostic::error(
                            "port_conflict",
                            &field,
                            "Active services request the same proposed host port/protocol.",
                        ));
                    }
                }
            }
        }
    }
    fn visit<'a>(
        name: &'a str,
        services: &'a BTreeMap<String, ServicePlan>,
        visiting: &mut BTreeSet<&'a str>,
        done: &mut BTreeSet<&'a str>,
    ) -> bool {
        if done.contains(name) {
            return true;
        }
        if !visiting.insert(name) {
            return false;
        }
        if let Some(service) = services.get(name) {
            for dependency in service.dependencies.keys() {
                if services.contains_key(dependency) && !visit(dependency, services, visiting, done)
                {
                    return false;
                }
            }
        }
        visiting.remove(name);
        done.insert(name);
        true
    }
    let mut visiting = BTreeSet::new();
    let mut done = BTreeSet::new();
    for name in services.keys() {
        if !visit(name, services, &mut visiting, &mut done) {
            diagnostics.push(Diagnostic::error(
                "dependency_cycle",
                "services",
                "The dependency graph contains a cycle.",
            ));
            break;
        }
    }
}
