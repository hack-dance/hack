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
    network_aliases(services, diagnostics);
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

/// One owner per DNS name on each network. A name is owned by a service's own
/// name and by its declared aliases on that network; Docker would otherwise
/// round-robin the name between containers. Only collisions that involve an
/// alias are reported, so documents without aliases review as before. A
/// collision with a service the selected profiles leave inactive is a
/// warning: that container never runs with this plan, and selecting its
/// profile makes the collision an error.
fn network_aliases(services: &BTreeMap<String, ServicePlan>, diagnostics: &mut Vec<Diagnostic>) {
    // (network, name) -> [(service, is_alias)]
    let mut owners: BTreeMap<(&str, String), Vec<(&str, bool)>> = BTreeMap::new();
    for (name, service) in services {
        for network in &service.networks {
            owners
                .entry((network, name.to_ascii_lowercase()))
                .or_default()
                .push((name, false));
            for alias in service.network_aliases.get(network).into_iter().flatten() {
                owners
                    .entry((network, alias.clone()))
                    .or_default()
                    .push((name, true));
            }
        }
    }
    let mut reported = BTreeSet::new();
    for claims in owners.values() {
        if claims.len() < 2 || !claims.iter().any(|(_, alias)| *alias) {
            continue;
        }
        for (index, (first, _)) in claims.iter().enumerate() {
            for (second, _) in &claims[index + 1..] {
                if first == second {
                    continue;
                }
                let both_active = services[*first].active && services[*second].active;
                let (code, message) = if both_active {
                    (
                        "network_alias_collision",
                        "Network aliases must have one owner per network and cannot replace another service name; values omitted.",
                    )
                } else {
                    (
                        "inactive_network_alias_collision",
                        "A network alias collides with a service the selected profiles leave inactive; selecting both is refused.",
                    )
                };
                for service in [*first, *second] {
                    if reported.insert((code, service)) {
                        let diagnostic = if both_active {
                            Diagnostic::error
                        } else {
                            Diagnostic::warning
                        };
                        diagnostics.push(diagnostic(
                            code,
                            &format!("services.{service}.networks"),
                            message,
                        ));
                    }
                }
            }
        }
    }
}
