//! Literal-preserving admission fingerprint for hostname-only reconfiguration.
//! Raw declarations are ephemeral: only a domain-separated digest enters the plan.
use super::{compose, yaml};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Hack-owned public runtime host metadata keys (the CLI's runtime host metadata
/// contract). Hack generates them only into the normalized document, with values derived
/// from the effective route hostnames, branch and HTTPS ingress port, so a hostname
/// change necessarily changes them. They are excluded from the normalized document's
/// fingerprint only: a value the user declares in the original Compose file is a literal
/// like any other and still counts (Hack never overrides a declared key).
const RUNTIME_METADATA_KEYS: [&str; 10] = [
    "HACK_ALIAS_HOST",
    "HACK_ALIAS_URL",
    "HACK_BRANCH",
    "HACK_COMPOSE_PROJECT",
    "HACK_DEV_HOST",
    "HACK_DEV_URL",
    "HACK_RUNTIME_METADATA",
    "HACK_SERVICE_NAME",
    "HACK_SERVICE_URL",
    "HACK_SERVICE_URLS",
];

fn without_runtime_metadata(service: &mut Value) {
    let reserved = |key: &str| RUNTIME_METADATA_KEYS.contains(&key);
    match service.get_mut("environment") {
        Some(Value::Object(environment)) => environment.retain(|key, _| !reserved(key)),
        Some(Value::Array(environment)) => environment.retain(|entry| {
            !entry
                .as_str()
                .is_some_and(|text| reserved(text.split_once('=').map_or(text, |(key, _)| key)))
        }),
        _ => {}
    }
}

fn masked(bytes: &[u8], generated_metadata: bool) -> Option<Value> {
    let mut value = yaml::parse(bytes).ok()?;
    let services = value.get_mut("services")?.as_object_mut()?;
    let mut routed = false;
    for service in services.values_mut() {
        if generated_metadata {
            without_runtime_metadata(service);
        }
        let Some(labels) = service.get_mut("labels") else {
            continue;
        };
        if compose::routing::parse(Some(labels)).ok()?.is_none() {
            continue;
        }
        routed = true;
        match labels {
            Value::Object(labels) => {
                *labels.get_mut("caddy")? = Value::String("<reviewed-hostnames>".into());
            }
            Value::Array(labels) => {
                let value = labels.iter_mut().find(|entry| {
                    entry
                        .as_str()
                        .is_some_and(|text| text.starts_with("caddy="))
                })?;
                *value = Value::String("caddy=<reviewed-hostnames>".into());
            }
            _ => return None,
        }
    }
    routed.then_some(value)
}

/// Unsupported original routing simply cannot opt into future hostname changes.
/// Both documents matter: normalization must not conceal unrelated original edits.
pub(super) fn fingerprint(original: &[u8], normalized: &[u8]) -> Option<String> {
    let original = masked(original, false)?;
    let normalized = masked(normalized, true)?;
    let bytes = zeroize::Zeroizing::new(
        serde_json::to_vec(&("hack-hostname-raw-v1", original, normalized)).ok()?,
    );
    Some(format!("{:x}", Sha256::digest(bytes.as_slice())))
}

#[cfg(test)]
mod tests {
    use super::*;
    const BASE: &str = "services:\n  web:\n    image: example:one\n    command: [echo, original]\n    environment: {TOKEN: literal}\n    labels:\n      caddy: web.hack\n      caddy.reverse_proxy: '{{upstreams 3000}}'\n      caddy.tls: internal\n";

    #[test]
    fn fingerprints_only_allow_hostname_values_to_change() {
        let expected = fingerprint(BASE.as_bytes(), BASE.as_bytes()).unwrap();
        let aliases = BASE.replace("caddy: web.hack", "caddy: web.hack, web.v5.hack.gy");
        assert_eq!(
            fingerprint(aliases.as_bytes(), aliases.as_bytes()),
            Some(expected.clone())
        );
        for changed in [
            BASE.replace("original", "different"),
            BASE.replace("literal", "different"),
            BASE.replace("example:one", "example:two"),
            BASE.replace("3000", "3001"),
            BASE.replace("internal", "external"),
            BASE.replace("  web:", "  another:"),
            format!("{BASE}    volumes: ['.:/different:ro']\n"),
            format!("{BASE}    healthcheck: {{test: [CMD, false]}}\n"),
            format!("{BASE}    networks: [other]\n"),
        ] {
            assert_ne!(
                fingerprint(changed.as_bytes(), BASE.as_bytes()),
                Some(expected.clone())
            );
            assert_ne!(
                fingerprint(BASE.as_bytes(), changed.as_bytes()),
                Some(expected.clone())
            );
        }
        for host in ["*.hack", "web.hack, web.hack", "${HOST}", ""] {
            let changed = BASE.replace("caddy: web.hack", &format!("caddy: '{host}'"));
            assert!(fingerprint(changed.as_bytes(), changed.as_bytes()).is_none());
        }
    }

    #[test]
    fn list_labels_preserve_every_other_literal_and_shape() {
        let before = b"services: {web: {labels: ['caddy=a.hack', 'caddy.reverse_proxy={{upstreams 80}}', 'caddy.tls=internal']}}";
        let after = b"services: {web: {labels: ['caddy=b.hack', 'caddy.reverse_proxy={{upstreams 80}}', 'caddy.tls=internal']}}";
        assert_eq!(fingerprint(before, before), fingerprint(after, after));
        assert!(fingerprint(b"services: {web: {image: alpine}}", after).is_none());
    }

    #[test]
    fn runtime_metadata_follows_hostnames_but_other_environment_still_counts() {
        let expected = fingerprint(BASE.as_bytes(), BASE.as_bytes()).unwrap();
        let metadata = |host: &str, port: &str| {
            BASE.replace("caddy: web.hack", &format!("caddy: {host}"))
                .replace(
                    "environment: {TOKEN: literal}",
                    &format!(
                        "environment: {{TOKEN: literal, HACK_DEV_URL: 'https://{host}{port}', HACK_SERVICE_URLS: '[\"https://{host}{port}\"]', HACK_RUNTIME_METADATA: '{{\"version\":1}}', HACK_BRANCH: ''}}"
                    ),
                )
        };
        for normalized in [
            metadata("web.hack", ""),
            metadata("web.v5.hack.gy", ""),
            metadata("web.hack", ":8443"),
        ] {
            assert_eq!(
                fingerprint(BASE.as_bytes(), normalized.as_bytes()),
                Some(expected.clone())
            );
        }
        let list = |url: &str| {
            format!(
                "services: {{web: {{environment: ['TOKEN=literal', 'HACK_DEV_URL={url}', HACK_SERVICE_NAME], labels: ['caddy=a.hack', 'caddy.reverse_proxy={{{{upstreams 80}}}}', 'caddy.tls=internal']}}}}"
            )
        };
        let plain = list("https://a.hack");
        assert_eq!(
            fingerprint(plain.as_bytes(), plain.as_bytes()),
            fingerprint(
                plain.as_bytes(),
                list("https://b.hack:8443")
                    .replace("caddy=a.hack", "caddy=b.hack")
                    .as_bytes()
            )
        );
        for changed in [
            metadata("web.hack", "").replace("TOKEN: literal", "TOKEN: different"),
            metadata("web.hack", "").replace("HACK_BRANCH", "HACK_OTHER"),
            plain.replace("TOKEN=literal", "TOKEN=different"),
        ] {
            assert_ne!(
                fingerprint(BASE.as_bytes(), changed.as_bytes()),
                Some(expected.clone())
            );
            assert_ne!(
                fingerprint(plain.as_bytes(), changed.as_bytes()),
                fingerprint(plain.as_bytes(), plain.as_bytes())
            );
        }
    }

    #[test]
    fn user_declared_metadata_keys_still_count_in_the_original() {
        let declared = |host: &str, url: &str| {
            BASE.replace("caddy: web.hack", &format!("caddy: {host}"))
                .replace(
                    "environment: {TOKEN: literal}",
                    &format!("environment: {{TOKEN: literal, HACK_DEV_URL: '{url}'}}"),
                )
        };
        // Hack skips a declared key, so the normalized document carries the user's value.
        let before = declared("web.hack", "https://custom.example");
        let expected = fingerprint(before.as_bytes(), before.as_bytes()).unwrap();
        let moved = declared("web.v5.hack.gy", "https://custom.example");
        assert_eq!(
            fingerprint(moved.as_bytes(), moved.as_bytes()),
            Some(expected.clone())
        );
        let edited = declared("web.v5.hack.gy", "https://other.example");
        assert_ne!(
            fingerprint(edited.as_bytes(), edited.as_bytes()),
            Some(expected)
        );
        let list = |url: &str| {
            format!(
                "services: {{web: {{environment: ['HACK_DEV_URL={url}'], labels: ['caddy=a.hack', 'caddy.reverse_proxy={{{{upstreams 80}}}}', 'caddy.tls=internal']}}}}"
            )
        };
        let plain = list("https://custom.example");
        let edited = list("https://other.example");
        assert_ne!(
            fingerprint(plain.as_bytes(), plain.as_bytes()),
            fingerprint(edited.as_bytes(), edited.as_bytes())
        );
        // Generated metadata differences in the normalized document still do not count.
        let base = fingerprint(BASE.as_bytes(), BASE.as_bytes()).unwrap();
        for (host, port) in [("web.hack", ""), ("web.v5.hack.gy", ":8443")] {
            let original = BASE.replace("caddy: web.hack", &format!("caddy: {host}"));
            let generated = original.replace(
                "environment: {TOKEN: literal}",
                &format!(
                    "environment: {{TOKEN: literal, HACK_DEV_URL: 'https://{host}{port}', HACK_DEV_HOST: {host}}}"
                ),
            );
            assert_eq!(
                fingerprint(original.as_bytes(), generated.as_bytes()),
                Some(base.clone())
            );
        }
    }
}
