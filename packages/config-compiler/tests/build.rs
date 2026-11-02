use hack_config_compiler::compile;
use serde_json::{Value, json};

fn compiled(input: &Value) -> Value {
    serde_json::to_value(compile(&serde_json::to_vec(input).unwrap(), &[])).unwrap()
}

#[test]
fn existing_build_paths_target_and_policy_are_normalized_without_new_options() {
    let input = json!({
        "schema_version": 1, "name": "fixture",
        "services": {"builder": {
            "build": {"context": "./build-${AMBIENT}/.", "dockerfile": "./docker/Dockerfile", "target": "selected"},
            "pull_policy": "build"
        }},
        "jobs": {"defaultfile": {"build": {"context": "default-context"}}}
    });
    let first = compiled(&input);
    assert_eq!(first["ok"], true);
    assert_eq!(
        first["plan"]["services"]["builder"]["build"],
        json!({
            "context": "build-${AMBIENT}", "dockerfile": "docker/Dockerfile", "target": "selected"
        })
    );
    assert_eq!(first["plan"]["services"]["builder"]["pull_policy"], "build");
    assert_eq!(
        first["plan"]["jobs"]["defaultfile"]["build"],
        json!({
            "context": "default-context", "dockerfile": "Dockerfile"
        })
    );
    assert_eq!(first, compiled(&input));
}

#[test]
fn advanced_build_requirements_refuse_in_each_namespace_and_profile_state() {
    for field in [
        "args",
        "platform",
        "platforms",
        "additional_contexts",
        "cache_from",
        "cache_to",
        "no_cache",
        "pull",
        "network",
        "secrets",
        "ssh",
    ] {
        for namespace in ["services", "jobs"] {
            for inactive in [false, true] {
                let mut input = json!({
                    "schema_version": 1, "name": "fixture", "profiles": ["dev"],
                    namespace: {"unsupported": {"build": {"context": "."}}}
                });
                input[namespace]["unsupported"]["build"][field] =
                    json!({"value": "private-build-canary"});
                if inactive {
                    input[namespace]["unsupported"]["profiles"] = json!(["dev"]);
                }
                let result = compiled(&input);
                assert_eq!(result["ok"], false, "{namespace}/{field}/{inactive}");
                assert_eq!(result["diagnostics"][0]["code"], "unknown_field");
                assert_eq!(
                    result["diagnostics"][0]["pointer"],
                    format!("/{namespace}/unsupported/build/{field}")
                );
                assert!(!result.to_string().contains("private-build-canary"));
                assert!(result.get("plan").is_none());
            }
        }
    }
}
