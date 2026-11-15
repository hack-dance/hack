//! Reviewed local HTTPS intent admission; publication remains a separate owner effect.
use super::*;
use crate::project::{PlanData, RoutingPlan, execution::Graph};

pub(super) fn recognized(key: &str) -> bool {
    matches!(key, "caddy" | "caddy.reverse_proxy" | "caddy.tls")
}

fn refused() -> CandidateError {
    error(
        "graph_route_binding",
        "Routing requires enrolled publication, unique canonical hostnames, project networks and matching native HTTP healthy readiness; values omitted.",
    )
}

pub(super) fn valid_intent(route: &RoutingPlan) -> bool {
    route.port != 0
        && !route.hostnames.is_empty()
        && route.hostnames.len() <= 8
        && route.hostnames.windows(2).all(|pair| pair[0] < pair[1])
        && route.hostnames.iter().all(|host| {
            super::super::publication::normalize_hostname(host)
                .is_ok_and(|normalized| normalized == *host)
        })
}

pub(super) fn validate_plan(
    plan: &PlanData,
    graph: &Graph,
    enrolled: bool,
) -> Result<(), CandidateError> {
    validate_services(&plan.services, graph, enrolled)
}

fn validate_services(
    services: &BTreeMap<String, project::ServicePlan>,
    graph: &Graph,
    enrolled: bool,
) -> Result<(), CandidateError> {
    let mut hosts = BTreeMap::new();
    let mut findings = Vec::new();
    let mut count = 0;
    for (name, service) in services.iter().filter(|(_, service)| service.active) {
        let Some(route) = &service.routing else {
            continue;
        };
        let mut refuse = |field, message, fix| {
            findings.push(
                crate::error::ConfigurationRefusal::new(field, message, fix).with_service(name),
            )
        };
        count += 1;
        if count > 32 || !enrolled {
            refuse(
                "labels.caddy",
                "The route has no available enrolled publication.",
                "Keep at most 32 routed services and start through hack up after configuring native HTTPS.",
            );
        }
        let health = service
            .healthcheck
            .as_ref()
            .filter(|health| !health.disabled);
        let probe = health.and_then(|health| health.native_http.as_ref());
        if graph.services.get(name).map(|service| service.ready) != Some(Condition::Healthy) {
            refuse(
                "healthcheck",
                "The routed service does not have healthy readiness.",
                "Use a long-running service with an enabled native HTTP healthcheck for route readiness.",
            );
        }
        if service.network_mode != "project-networks" || service.networks.is_empty() {
            refuse(
                "networks",
                "The routed service has no project-network endpoint.",
                "Remove network_mode and attach the routed service to a declared project network.",
            );
        }
        if !probe.is_some_and(|probe| probe.port == route.port && probe.validate().is_ok()) {
            refuse(
                "healthcheck.x-hack-http",
                "The route needs a valid native HTTP probe on its upstream port.",
                "Set healthcheck.x-hack-http to the route port and readiness path, or omit the authored healthcheck to use the inferred route probe. A command-only healthcheck cannot establish route readiness.",
            );
        }
        if probe.is_some_and(|probe| {
            probe.policy.is_some()
                && *probe != super::super::http_probe::HttpProbe::inferred_route(route.port)
        }) {
            refuse(
                "healthcheck.x-hack-http",
                "The inferred route probe policy was changed.",
                "Omit the authored healthcheck to use the default inferred probe, or declare an explicit native HTTP probe without an inferred policy.",
            );
        }
        if !valid_intent(route) {
            refuse(
                "labels.caddy",
                "The route does not have canonical distinct hostnames and a nonzero port.",
                "Declare one to eight distinct canonical hostnames and a literal upstream port in the supported Caddy labels.",
            );
        }
        for key in ["caddy", "caddy.reverse_proxy", "caddy.tls"] {
            if !service.labels.get(key).is_some_and(|value| {
                value.environment_references.is_empty() && value.literal_redacted
            }) {
                let field = match key {
                    "caddy" => "labels.caddy",
                    "caddy.tls" => "labels.caddy.tls",
                    _ => "labels.caddy.reverse_proxy",
                };
                refuse(
                    field,
                    "A required route label is missing or uses an environment reference.",
                    "Declare literal caddy hostnames, caddy.reverse_proxy with {{upstreams PORT}}, and caddy.tls: internal.",
                );
            }
        }
        if service.labels.keys().any(|key| {
            !recognized(key)
                && !crate::project::inert_metadata_label(key)
                && !(service.dependency_cache.is_some()
                    && matches!(
                        key.as_str(),
                        "hack.dependencies.cache-volume"
                            | "hack.dependencies.lockfiles"
                            | "hack.dependencies.runtime-files"
                            | "hack.dependencies.bootstrap"
                    ))
        }) {
            refuse(
                "labels",
                "The routed service has unsupported semantic labels.",
                "Remove other router or ownership labels; keep the supported Caddy and dependency-cache labels. Use Compose if another router is required.",
            );
        }
        for host in &route.hostnames {
            if let Some(previous) = hosts.insert(host, name) {
                let detail = crate::error::ConfigurationRefusal::new(
                    "labels.caddy",
                    "Multiple routes claim the same hostname.",
                    "Assign distinct hostnames to the routed services; one hostname can belong to only one route.",
                );
                findings.push(detail.clone().with_service(previous));
                findings.push(detail.with_service(name));
            }
        }
    }
    if findings.is_empty() {
        Ok(())
    } else {
        Err(refused().with_configuration_refusals(findings))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (BTreeMap<String, project::ServicePlan>, Graph) {
        // Deserialize the real public plan shape, without filesystem or Engine effects.
        let service = json!({"active":true,"profiles":[],"dependencies":{},"mounts":[],"environment":{},"environment_files":[],"environment_precedence":"test","ports":[],"exposed_ports":[],"networks":["default"],"network_mode":"project-networks","limits":{},"read_only":true,"init":true,"restart":"no","labels":{"caddy":{"environment_references":[],"literal_redacted":true},"caddy.reverse_proxy":{"environment_references":[],"literal_redacted":true},"caddy.tls":{"environment_references":[],"literal_redacted":true}},"routing":{"hostnames":["search.example-app.hack","search.example-app.hack.gy"],"port":6980},"healthcheck":{"disabled":false,"native_http":{"port":6980,"path":"/search/health","interval_ms":100,"timeout_ms":500,"retries":3,"start_period_ms":0}}});
        let service: project::ServicePlan = serde_json::from_value(service).unwrap();
        let plan = BTreeMap::from([("search".into(), service)]);
        let graph = Graph {
            services: BTreeMap::from([(
                "search".into(),
                project::execution::Service {
                    dependencies: BTreeMap::new(),
                    ready: Condition::Healthy,
                },
            )]),
        };
        (plan, graph)
    }

    #[test]
    fn reports_each_service_and_independent_route_field_without_values() {
        let (mut plan, mut graph) = fixture();
        let service = plan.get_mut("search").unwrap();
        service.healthcheck = None;
        service.networks.clear();
        service.labels.remove("caddy.tls");
        service.routing.as_mut().unwrap().hostnames = vec!["private-sentinel.example".into()];
        plan.insert("other".into(), plan["search"].clone());
        graph
            .services
            .insert("other".into(), graph.services["search"].clone());
        let error = validate_services(&plan, &graph, true).unwrap_err();
        assert_eq!(error.code, "graph_route_binding");
        let wire = serde_json::to_value(&error).unwrap();
        let findings = wire["configuration_refusals"].as_array().unwrap();
        for service in ["search", "other"] {
            for field in [
                "networks",
                "healthcheck.x-hack-http",
                "labels.caddy.tls",
                "labels.caddy",
            ] {
                assert!(
                    findings
                        .iter()
                        .any(|item| item["service"] == service && item["field"] == field),
                    "{wire}"
                );
            }
        }
        assert!(!wire.to_string().contains("private-sentinel"));
    }

    #[test]
    fn actual_search_requires_enrollment_and_matching_health() {
        let (mut plan, mut graph) = fixture();
        assert!(validate_services(&plan, &graph, true).is_ok());
        assert_eq!(
            validate_services(&plan, &graph, false).unwrap_err().code,
            "graph_route_binding"
        );
        graph.services.get_mut("search").unwrap().ready = Condition::Started;
        assert!(validate_services(&plan, &graph, true).is_err());
        graph.services.get_mut("search").unwrap().ready = Condition::Healthy;
        plan.get_mut("search")
            .unwrap()
            .routing
            .as_mut()
            .unwrap()
            .port = 6981;
        assert!(validate_services(&plan, &graph, true).is_err());
    }

    #[test]
    fn refuses_duplicates_incomplete_and_noncanonical_intent() {
        let (mut plan, mut graph) = fixture();
        plan.insert("other".into(), plan["search"].clone());
        graph
            .services
            .insert("other".into(), graph.services["search"].clone());
        assert!(validate_services(&plan, &graph, true).is_err());
        plan.remove("other");
        plan.get_mut("search").unwrap().labels.remove("caddy.tls");
        assert!(validate_services(&plan, &graph, true).is_err());
        let (mut owner_plan, owner_graph) = fixture();
        owner_plan.get_mut("search").unwrap().labels.insert(
            "com.docker.compose.project".into(),
            project::RedactedText {
                environment_references: vec![],
                literal_redacted: true,
            },
        );
        // An authored Compose owner label is ignored metadata, not route or
        // Engine authority; fresh native ownership is generated separately.
        assert!(validate_services(&owner_plan, &owner_graph, true).is_ok());
        for hosts in [
            vec![],
            vec!["UPPER.example".into()],
            vec!["same.example".into(); 2],
            vec!["*.example".into()],
        ] {
            assert!(!valid_intent(&RoutingPlan {
                hostnames: hosts,
                port: 6980
            }));
        }
        plan.get_mut("search").unwrap().routing = None;
        assert!(validate_services(&plan, &graph, true).is_ok());
    }
}
