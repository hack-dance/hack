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
    let mut hosts = BTreeSet::new();
    let mut count = 0;
    for (name, service) in services.iter().filter(|(_, service)| service.active) {
        let Some(route) = &service.routing else {
            continue;
        };
        count += 1;
        if count > 32 || !enrolled {
            return Err(refused());
        }
        let health = service
            .healthcheck
            .as_ref()
            .filter(|health| !health.disabled);
        let probe = health.and_then(|health| health.native_http.as_ref());
        if graph.services.get(name).map(|service| service.ready) != Some(Condition::Healthy)
            || service.network_mode != "project-networks"
            || service.networks.is_empty()
            || !probe.is_some_and(|probe| probe.port == route.port && probe.validate().is_ok())
            || !valid_intent(route)
            || !["caddy", "caddy.reverse_proxy", "caddy.tls"]
                .iter()
                .all(|key| {
                    service.labels.get(*key).is_some_and(|value| {
                        value.environment_references.is_empty() && value.literal_redacted
                    })
                })
            || service.labels.keys().any(|key| {
                !recognized(key)
                    && !(service.dependency_cache.is_some()
                        && matches!(
                            key.as_str(),
                            "hack.dependencies.cache-volume"
                                | "hack.dependencies.lockfiles"
                                | "hack.dependencies.runtime-files"
                                | "hack.dependencies.bootstrap"
                        ))
            })
        {
            return Err(refused());
        }
        for host in &route.hostnames {
            if !hosts.insert(host) {
                return Err(refused());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (BTreeMap<String, project::ServicePlan>, Graph) {
        // Deserialize the real public plan shape, without filesystem or Engine effects.
        let service = json!({"active":true,"profiles":[],"dependencies":{},"mounts":[],"environment":{},"environment_files":[],"environment_precedence":"test","ports":[],"exposed_ports":[],"networks":["default"],"network_mode":"project-networks","limits":{},"read_only":true,"init":true,"restart":"no","labels":{"caddy":{"environment_references":[],"literal_redacted":true},"caddy.reverse_proxy":{"environment_references":[],"literal_redacted":true},"caddy.tls":{"environment_references":[],"literal_redacted":true}},"routing":{"hostnames":["search.livenation.hack","search.livenation.hack.gy"],"port":6980},"healthcheck":{"disabled":false,"native_http":{"port":6980,"path":"/search/health","interval_ms":100,"timeout_ms":500,"retries":3,"start_period_ms":0}}});
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
        assert!(validate_services(&owner_plan, &owner_graph, true).is_err());
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
