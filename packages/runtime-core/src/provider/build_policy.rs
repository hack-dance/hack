//! BuildKit source policy for native image builds.
//!
//! The engine resolves `ADD` URLs, git sources and image blobs from the guest's own
//! network namespace, outside the build network's isolation. The Dockerfile
//! scanner refuses such sources in the Dockerfile itself, but it cannot see
//! `ONBUILD` triggers stored in a pinned base image's configuration. This policy
//! closes that gap independent of parsing: the solver evaluates every source
//! operation of the build against it, including ones a base image's triggers add,
//! and fails the build on a denied source.
//!
//! The build step writes [`document`] to a private file and passes its path in
//! `EXPERIMENTAL_BUILDKIT_SOURCE_POLICY` to the pinned `buildx` client, which reads
//! it for `build` and `bake` and sends it with the solve request. The document uses
//! the JSON form of BuildKit's `sourcepolicy` `Policy` message, with string enum
//! names. Rules match source identifiers by wildcard; a later matching rule wins,
//! and a source no rule matches is allowed, so `docker-image` and `local` sources
//! (the pinned contexts and the build context) still resolve.

use serde_json::{Value, json};

/// Source identifier schemes that fetch over the network outside image pulls.
pub const DENIED_SCHEMES: [&str; 4] = ["http", "https", "git", "docker-image+blob"];

/// The source policy every native build runs with.
pub fn document() -> Value {
    let rules: Vec<Value> = DENIED_SCHEMES
        .iter()
        .map(|scheme| {
            json!({
                "action": "DENY",
                "selector": {
                    "identifier": format!("{scheme}://*"),
                    "match_type": "WILDCARD",
                },
            })
        })
        .collect();
    json!({ "version": 1, "rules": rules })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_policy_denies_every_network_source_scheme_and_nothing_else() {
        let policy = document();
        assert_eq!(policy["version"], 1);
        let rules = policy["rules"].as_array().unwrap();
        let identifiers: Vec<&str> = rules
            .iter()
            .map(|rule| {
                // Only the fields BuildKit's `Rule`/`Selector` JSON tags define.
                assert_eq!(rule.as_object().unwrap().len(), 2);
                assert_eq!(rule["action"], "DENY");
                assert_eq!(rule["selector"]["match_type"], "WILDCARD");
                assert_eq!(rule["selector"].as_object().unwrap().len(), 2);
                rule["selector"]["identifier"].as_str().unwrap()
            })
            .collect();
        assert_eq!(
            identifiers,
            ["http://*", "https://*", "git://*", "docker-image+blob://*"]
        );
        // No rule touches image or local sources, so pinned contexts still resolve.
        assert!(
            identifiers
                .iter()
                .all(|id| !id.starts_with("docker-image://") && !id.starts_with("local://"))
        );
    }
}
