//! Compose project identity for interpolation and container-name DNS.
//!
//! Compose exposes its project name to interpolation as `COMPOSE_PROJECT_NAME`
//! and names each container `<project>-<service>-<index>`, which the engine
//! resolves on every network the container joins. Review binds both to the
//! document's top-level `name` only when a service references the variable:
//! other plans keep their identity and normalized bytes. The name is public
//! project metadata, never a secret value.
use super::super::*;
use super::service::network_alias;
use serde_json::Value;

/// Interpolation key Compose reserves for the project name.
pub(crate) const VARIABLE: &str = "COMPOSE_PROJECT_NAME";

/// Compose's project-name rule: lowercase letters, digits, `-` and `_`,
/// starting with a letter or digit.
fn valid(name: &str) -> bool {
    name.bytes()
        .next()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

fn references(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, value)| match value {
            Value::Array(names) if key == "environment_references" => {
                names.iter().any(|name| name == VARIABLE)
            }
            _ => references(value),
        }),
        Value::Array(values) => values.iter().any(references),
        _ => false,
    }
}

/// Compose's container DNS name for the single replica of `service`.
pub(crate) fn container_alias(project: &str, service: &str) -> String {
    format!("{project}-{service}-1").to_ascii_lowercase()
}

/// Bind the declared project name when services reference it, and add each
/// service's Compose container name as an alias on every attachment. Collision
/// review runs afterwards over the complete alias set.
pub(super) fn bind(
    declared: Option<&str>,
    services: &mut BTreeMap<String, ServicePlan>,
    diagnostics: &mut Vec<Diagnostic>,
    at: usize,
) -> Result<Option<String>, CandidateError> {
    let referenced = references(
        &serde_json::to_value(&*services)
            .map_err(|_| problem("serialization_failed", "Cannot encode review plan."))?,
    );
    let Some(name) = declared else {
        if referenced {
            diagnostics.insert(
                at,
                Diagnostic::warning(
                "compose_project_name_unbound",
                "compose.name",
                "COMPOSE_PROJECT_NAME is referenced but no top-level name is declared; execution refuses until the Hack frontend declares the instance's Compose project name.",
            ));
        }
        return Ok(None);
    };
    if !referenced {
        diagnostics.insert(
                at,
                Diagnostic::warning(
            "candidate_project_namespace",
            "compose.name",
            "The declared project name is replaced by a separate candidate namespace; no existing project is adopted.",
        ));
        return Ok(None);
    }
    if !valid(name) {
        diagnostics.push(Diagnostic::error(
            "invalid_compose_project_name",
            "compose.name",
            "COMPOSE_PROJECT_NAME requires a Compose project name of lowercase letters, digits, '-' or '_' that starts with a letter or digit.",
        ));
        return Ok(None);
    }
    diagnostics.insert(
                at,
                Diagnostic::warning(
        "compose_project_name_binding",
        "compose.name",
        "COMPOSE_PROJECT_NAME is bound to the declared project name, and each service also answers to its Compose container name on its networks; the candidate namespace still owns every resource.",
    ));
    for (service, plan) in services.iter_mut() {
        if plan.networks.is_empty() {
            continue;
        }
        let alias = container_alias(name, service);
        let field = format!("services.{service}.networks");
        if alias.len() > 63 {
            diagnostics.push(Diagnostic::error(
                "compose_container_alias_too_long",
                &field,
                "The Compose container name exceeds one 63-byte DNS label; shorten the project or service name.",
            ));
            continue;
        }
        let Some(alias) = network_alias(&alias) else {
            diagnostics.push(Diagnostic::error(
                "invalid_network_alias",
                &field,
                "The Compose container name is not an exact DNS name; values omitted.",
            ));
            continue;
        };
        for network in &plan.networks {
            let aliases = plan.network_aliases.entry(network.clone()).or_default();
            if !aliases.contains(&alias) {
                if aliases.len() >= MAX_NETWORK_ALIASES {
                    diagnostics.push(Diagnostic::error(
                        "invalid_network_alias",
                        &format!("{field}.aliases"),
                        "At most 8 network aliases are accepted per service attachment, including the Compose container name.",
                    ));
                    continue;
                }
                aliases.push(alias.clone());
                aliases.sort();
            }
        }
    }
    Ok(Some(name.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_names_follow_the_compose_rule() {
        for name in ["app", "app--feature-x", "a_b", "0app"] {
            assert!(valid(name), "{name}");
        }
        for name in ["", "App", "-app", "_app", "app.x", "app x"] {
            assert!(!valid(name), "{name}");
        }
        assert_eq!(container_alias("app--b", "Web"), "app--b-web-1");
    }

    #[test]
    fn references_are_found_anywhere_in_reviewed_text() {
        let nested = serde_json::json!({"web":{"command":{"arguments":[
            {"environment_references":["OTHER", VARIABLE],"literal_redacted":true}
        ]}}});
        assert!(references(&nested));
        let other = serde_json::json!({"web":{"environment":{"KEY":
            {"environment_references":["OTHER"],"literal_redacted":true}}}});
        assert!(!references(&other));
    }
}
