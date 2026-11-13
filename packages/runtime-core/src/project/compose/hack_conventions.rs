//! Pure compatibility with Hack-generated Compose metadata; never adoption authority.
use super::super::*;
use super::fields::*;
use serde_json::{Map, Value};

pub(super) fn network(
    name: &str,
    value: &Map<String, Value>,
) -> Result<(bool, Option<String>), CandidateError> {
    let external = match value.get("external") {
        None | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) | Some(Value::Object(_)) => true,
        _ => {
            return Err(problem(
                "invalid_network_replacement",
                "External network declaration must be a boolean or named mapping.",
            ));
        }
    };
    let legacy = value.get("external").and_then(Value::as_object);
    if legacy.is_some_and(|v| v.keys().any(|key| key != "name")) {
        return Err(problem(
            "invalid_network_replacement",
            "External network mapping accepts only its name.",
        ));
    }
    let legacy_name = legacy.and_then(|v| v.get("name")).map(string).transpose()?;
    let explicit = value.get("name").map(string).transpose()?;
    if matches!((legacy_name, explicit), (Some(a), Some(b)) if a != b) {
        return Err(problem(
            "invalid_network_replacement",
            "External network names disagree.",
        ));
    }
    let actual = explicit.or(legacy_name).unwrap_or(name);
    identifier(actual)?;
    Ok((
        external,
        (external && matches!(actual, "hack-dev" | "hack-logging")).then(|| actual.to_owned()),
    ))
}

pub(super) fn ignored_label(key: &str) -> bool {
    key == "com.docker.compose"
        || key.starts_with("com.docker.compose.")
        || super::ownership_labels::is_hack_ownership_label(key)
        || ((key == "hack" || key.starts_with("hack."))
            && key != "hack.dependencies"
            && key != "hack.service"
            && !key.starts_with("hack.dependencies.")
            && !key.starts_with("hack.service."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn only_exact_hack_network_identity_is_mapped() {
        for name in ["hack-dev", "hack-logging"] {
            for (logical, definition) in [
                (name, json!({"external":true})),
                ("alias", json!({"external":true,"name":name})),
                ("alias", json!({"external":{"name":name}})),
            ] {
                assert_eq!(
                    network(logical, definition.as_object().unwrap()).unwrap(),
                    (true, Some(name.to_owned()))
                );
            }
            assert_eq!(
                network(
                    name,
                    json!({"external":true,"name":"foreign"})
                        .as_object()
                        .unwrap()
                )
                .unwrap(),
                (true, None)
            );
            for definition in [
                json!({"external":{"name":name,"extra":true}}),
                json!({"external":{"name":name},"name":"foreign"}),
            ] {
                assert!(network(name, definition.as_object().unwrap()).is_err());
            }
        }
    }
}
