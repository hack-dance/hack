//! A bounded subset of public Caddy labels, not runtime routing authorization.
use super::super::*;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn recognized(key: &str) -> bool {
    matches!(key, "caddy" | "caddy.reverse_proxy" | "caddy.tls")
}

fn refused() -> CandidateError {
    problem(
        "invalid_routing_labels",
        "Routing requires only caddy hostnames, caddy.reverse_proxy with one upstream port, and caddy.tls=internal; declarations must be complete, unique and bounded; values omitted.",
    )
}

/// Reads only routing labels and leaves unrelated declarations untouched. Indexed
/// Caddy sites/directives are deliberately outside this subset. No filesystem,
/// environment interpolation, Caddy configuration or network effects occur here.
pub(crate) fn parse(value: Option<&Value>) -> Result<Option<RoutingPlan>, CandidateError> {
    let mut routing = BTreeMap::new();
    let mut take = |key: &str, value: &Value| -> Result<(), CandidateError> {
        if !key.starts_with("caddy") {
            return Ok(());
        }
        if !recognized(key) {
            return Err(refused());
        }
        let text = value.as_str().ok_or_else(refused)?;
        if text.len() > 8192 || text.chars().any(char::is_control) {
            return Err(refused());
        }
        if routing.insert(key.to_owned(), text.to_owned()).is_some() {
            return Err(refused());
        }
        Ok(())
    };
    match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(labels)) => {
            for (key, value) in labels {
                take(key, value)?;
            }
        }
        Some(Value::Array(labels)) => {
            for label in labels {
                let label = label.as_str().ok_or_else(refused)?;
                let (key, value) = label.split_once('=').unwrap_or((label, ""));
                take(key, &Value::String(value.to_owned()))?;
            }
        }
        _ => return Err(refused()),
    }
    if routing.is_empty() {
        return Ok(None);
    }
    if routing.len() != 3 || routing.get("caddy.tls").map(String::as_str) != Some("internal") {
        return Err(refused());
    }
    let mut hosts = BTreeSet::new();
    for host in routing.get("caddy").ok_or_else(refused)?.split(',') {
        let host =
            crate::provider::publication::normalize_hostname(host.trim()).map_err(|_| refused())?;
        if !hosts.insert(host) || hosts.len() > 8 {
            return Err(refused());
        }
    }
    let port = routing
        .get("caddy.reverse_proxy")
        .and_then(|value| value.strip_prefix("{{upstreams "))
        .and_then(|value| value.strip_suffix("}}"))
        .filter(|value| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .ok_or_else(refused)?;
    Ok(Some(RoutingPlan {
        hostnames: hosts.into_iter().collect(),
        port,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn labels(hosts: &str, port: &str) -> Value {
        json!({"caddy":hosts,"caddy.reverse_proxy":format!("{{{{upstreams {port}}}}}"),"caddy.tls":"internal"})
    }

    #[test]
    fn normalizes_search_pair_and_supported_ports() {
        for port in [1, 6980, 65535] {
            let value = labels(
                "Search.Event-Agent.Hack., search.event-agent.localhost",
                &port.to_string(),
            );
            let route = parse(Some(&value)).unwrap().unwrap();
            assert_eq!(route.port, port);
            assert_eq!(
                route.hostnames,
                ["search.event-agent.hack", "search.event-agent.localhost"]
            );
        }
    }

    #[test]
    fn accepts_all_actual_event_agent_route_shapes() {
        for (prefix, port) in [
            ("consumer-sessions.", 3333),
            ("chat.", 3001),
            ("", 3000),
            ("chat-2.", 9001),
            ("data-sync.", 9002),
            ("crawl.", 9007),
            ("core.", 6969),
            ("search.", 6980),
            ("ws.", 6970),
        ] {
            let hosts = format!("{prefix}livenation.hack, {prefix}livenation.hack.gy");
            let route = parse(Some(&labels(&hosts, &port.to_string())))
                .unwrap()
                .unwrap();
            assert_eq!(route.port, port);
            assert_eq!(route.hostnames.len(), 2);
        }
    }

    #[test]
    fn unrelated_labels_are_untouched_and_list_mapping_matches() {
        let unrelated = json!({"other":null,"hack.dependencies.bootstrap":"true"});
        assert_eq!(parse(Some(&unrelated)).unwrap(), None);
        assert_eq!(parse(None).unwrap(), None);
        let list = json!([
            "other=value=with=equals",
            "caddy=search.example",
            "caddy.reverse_proxy={{upstreams 6980}}",
            "caddy.tls=internal"
        ]);
        assert_eq!(
            parse(Some(&list)).unwrap(),
            parse(Some(&labels("search.example", "6980"))).unwrap()
        );
        assert_eq!(unrelated["other"], Value::Null);
    }

    #[test]
    fn refuses_partial_extra_indexed_and_duplicate_labels() {
        for key in ["caddy", "caddy.reverse_proxy", "caddy.tls"] {
            let mut value = labels("search.example", "6980");
            value.as_object_mut().unwrap().remove(key);
            assert!(parse(Some(&value)).is_err());
        }
        for key in [
            "caddy.header",
            "caddy.0",
            "caddy_0",
            "caddy.reverse_proxy.0",
        ] {
            let mut value = labels("search.example", "6980");
            value[key] = json!("canary");
            let error = parse(Some(&value)).unwrap_err();
            assert!(!error.message.contains("canary"));
        }
        assert!(
            parse(Some(&json!([
                "caddy=x.example",
                "caddy=x.example",
                "caddy.tls=internal",
                "caddy.reverse_proxy={{upstreams 1}}"
            ])))
            .is_err()
        );
    }

    #[test]
    fn refuses_port_commands_interpolation_and_unsafe_hosts() {
        for port in ["0", "65536", "-1", "1 2", "${PORT}", "1}}; evil {{", ""] {
            assert!(parse(Some(&labels("search.example", port))).is_err());
        }
        for hosts in [
            "",
            "x.example,",
            "x.example,X.EXAMPLE.",
            "*.example",
            "https://x.example",
            "${HOST}",
            "x.example\nother",
            "127.0.0.1",
        ] {
            assert!(parse(Some(&labels(hosts, "6980"))).is_err());
        }
    }

    #[test]
    fn enforces_host_count_and_value_bounds() {
        let hosts = (0..8).map(|i| format!("h{i}.example")).collect::<Vec<_>>();
        assert!(parse(Some(&labels(&hosts.join(","), "6980"))).is_ok());
        assert!(parse(Some(&labels(&(hosts.join(",") + ",extra.example"), "6980"))).is_err());
        assert!(parse(Some(&labels(&"x".repeat(8193), "6980"))).is_err());
        assert!(parse(Some(&json!({"caddy":true}))).is_err());
    }
}
