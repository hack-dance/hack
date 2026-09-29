//! Literal-preserving admission fingerprint for hostname-only reconfiguration.
//! Raw declarations are ephemeral: only a domain-separated digest enters the plan.
use super::{compose, yaml};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn masked(bytes: &[u8]) -> Option<Value> {
    let mut value = yaml::parse(bytes).ok()?;
    let services = value.get_mut("services")?.as_object_mut()?;
    let mut routed = false;
    for service in services.values_mut() {
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
    let original = masked(original)?;
    let normalized = masked(normalized)?;
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
}
