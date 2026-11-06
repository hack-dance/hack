//! BuildKit source policy for native image builds.
//!
//! The engine fetches `ADD` URLs, git sources and image blobs from the guest's own
//! network namespace, outside the build network's isolation, and pulls any image a
//! build names. The Dockerfile scanner refuses remote sources in the Dockerfile
//! itself, but it cannot see `ONBUILD` triggers stored in a pinned base image's
//! configuration, which may add remote sources or name other images.
//!
//! [`document`] is the policy meant to close that gap independent of parsing: the
//! solver checks every source operation of a build against it, including ones a
//! base image's triggers add, and fails the build on a denied source. **Nothing
//! applies it yet.** Until the build step writes it to a private file and passes
//! that path in `EXPERIMENTAL_BUILDKIT_SOURCE_POLICY` to the pinned `buildx`
//! client (which reads it for `build` and `bake`), `ONBUILD` triggers in base
//! images are not enforced.
//!
//! The document is the JSON form of BuildKit's `sourcepolicy` `Policy` message, with
//! string enum names. A rule matches when the source identifier equals its selector
//! identifier, or, for `WILDCARD`, matches it with `*` standing for any text. The
//! last matching rule decides, and a source no rule matches is allowed. Rules, in
//! order:
//!
//! 1. deny every `docker-image://` and `oci-layout://` source;
//! 2. allow exactly each pinned base image, as the identifier BuildKit gives a
//!    `docker-image://<reference>` named context: `docker-image://` and the
//!    normalized `docker.io/<namespace>/<repository>[:tag]@sha256:<digest>`;
//! 3. deny every `http`, `https`, `git` and `docker-image+blob` source.
//!
//! `local://` sources (the build context and Dockerfile) match no rule and resolve.

use super::image_reference::{ImageReference, normalize};
use crate::CandidateError;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// Image source schemes denied unless the exact pinned identifier is allowed.
pub const IMAGE_SCHEMES: [&str; 2] = ["docker-image", "oci-layout"];
/// Source schemes that fetch over the network, always denied.
pub const NETWORK_SCHEMES: [&str; 4] = ["http", "https", "git", "docker-image+blob"];

fn rule(action: &str, identifier: String, match_type: &str) -> Value {
    json!({
        "action": action,
        "selector": { "identifier": identifier, "match_type": match_type },
    })
}

/// The source policy a native build runs with, allowing only `pinned` images.
///
/// Each entry is a base image reference the build passes as a
/// `docker-image://<reference>` named context. It must be a public Docker Hub
/// reference pinned by digest; it is normalized the way BuildKit's `llb.Image`
/// normalizes it, so the allow rule equals the source identifier exactly.
pub fn document<'a>(pinned: impl IntoIterator<Item = &'a str>) -> Result<Value, CandidateError> {
    let mut allowed = BTreeSet::new();
    for reference in pinned {
        match normalize(reference) {
            Ok(ImageReference::Named(named))
                if named.digest.is_some() && named.docker_hub_repository().is_some() =>
            {
                allowed.insert(format!("docker-image://{}", named.canonical()));
            }
            _ => {
                return Err(CandidateError::new(
                    "native_build_base_image",
                    "A build source policy allows only digest-pinned public Docker Hub images.",
                ));
            }
        }
    }
    let mut rules: Vec<Value> = IMAGE_SCHEMES
        .iter()
        .map(|scheme| rule("DENY", format!("{scheme}://*"), "WILDCARD"))
        .collect();
    rules.extend(
        allowed
            .into_iter()
            .map(|identifier| rule("ALLOW", identifier, "EXACT")),
    );
    rules.extend(
        NETWORK_SCHEMES
            .iter()
            .map(|scheme| rule("DENY", format!("{scheme}://*"), "WILDCARD")),
    );
    Ok(json!({ "version": 1, "rules": rules }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    /// BuildKit's `Wildcard2Regexp`: `^...$` with each `*` matching any text.
    fn wildcard(pattern: &str, value: &str) -> bool {
        let parts: Vec<&str> = pattern.split('*').collect();
        let (first, last) = (parts[0], parts[parts.len() - 1]);
        if parts.len() == 1 {
            return pattern == value;
        }
        if !value.starts_with(first) || value.len() < first.len() + last.len() {
            return false;
        }
        let mut rest = &value[first.len()..value.len() - last.len()];
        if !value.ends_with(last) {
            return false;
        }
        for middle in &parts[1..parts.len() - 1] {
            match rest.find(middle) {
                Some(at) => rest = &rest[at + middle.len()..],
                None => return false,
            }
        }
        true
    }

    /// BuildKit's `evaluatePolicy` for ALLOW/DENY rules: the last match decides.
    fn allowed(policy: &Value, identifier: &str) -> bool {
        let mut deny = false;
        for rule in policy["rules"].as_array().unwrap() {
            let selector = &rule["selector"];
            let pattern = selector["identifier"].as_str().unwrap();
            let matched = pattern == identifier
                || (selector["match_type"] == "WILDCARD" && wildcard(pattern, identifier));
            if matched {
                deny = rule["action"] == "DENY";
            }
        }
        !deny
    }

    #[test]
    fn only_the_pinned_images_and_local_sources_are_allowed() {
        let alpine = format!("docker.io/library/alpine@{A}");
        let tagged = format!("node:24-slim@{B}");
        let policy = document([alpine.as_str(), tagged.as_str()]).unwrap();
        assert_eq!(policy["version"], 1);
        for identifier in [
            format!("docker-image://docker.io/library/alpine@{A}"),
            format!("docker-image://docker.io/library/node:24-slim@{B}"),
            "local://context".to_string(),
            "local://dockerfile".to_string(),
        ] {
            assert!(allowed(&policy, &identifier), "{identifier}");
        }
        for identifier in [
            // Unpinned, another digest, another repository with the same digest.
            "docker-image://docker.io/library/alpine:3.22".to_string(),
            "docker-image://docker.io/library/alpine:latest".to_string(),
            format!("docker-image://docker.io/library/alpine@{B}"),
            format!("docker-image://docker.io/library/busybox@{A}"),
            format!("docker-image://docker.io/library/node@{B}"),
            format!("docker-image://ghcr.io/example/app@{A}"),
            format!("oci-layout://store/alpine@{A}"),
            "https://example.com/a".to_string(),
            "http://example.com/a".to_string(),
            "git://github.com/org/repo.git".to_string(),
            format!("docker-image+blob://docker.io/library/alpine@{A}"),
        ] {
            assert!(!allowed(&policy, &identifier), "{identifier}");
        }
    }

    #[test]
    fn the_rule_list_has_the_documented_order_and_shape() {
        let short = format!("alpine@{A}");
        let policy = document([short.as_str(), short.as_str()]).unwrap();
        let rules: Vec<(String, String, String)> = policy["rules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|rule| {
                // Only the fields BuildKit's `Rule`/`Selector` JSON tags define.
                assert_eq!(rule.as_object().unwrap().len(), 2);
                assert_eq!(rule["selector"].as_object().unwrap().len(), 2);
                (
                    rule["action"].as_str().unwrap().to_string(),
                    rule["selector"]["identifier"].as_str().unwrap().to_string(),
                    rule["selector"]["match_type"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        let expected: Vec<(String, String, String)> = [
            ("DENY", "docker-image://*".to_string(), "WILDCARD"),
            ("DENY", "oci-layout://*".to_string(), "WILDCARD"),
            // Normalized like BuildKit's `llb.Image`, and listed once.
            (
                "ALLOW",
                format!("docker-image://docker.io/library/alpine@{A}"),
                "EXACT",
            ),
            ("DENY", "http://*".to_string(), "WILDCARD"),
            ("DENY", "https://*".to_string(), "WILDCARD"),
            ("DENY", "git://*".to_string(), "WILDCARD"),
            ("DENY", "docker-image+blob://*".to_string(), "WILDCARD"),
        ]
        .into_iter()
        .map(|(a, i, m)| (a.to_string(), i, m.to_string()))
        .collect();
        assert_eq!(rules, expected);
        // No pinned images: every image source is denied.
        let empty = document([]).unwrap();
        assert!(!allowed(
            &empty,
            &format!("docker-image://docker.io/library/alpine@{A}")
        ));
    }

    #[test]
    fn only_digest_pinned_docker_hub_references_are_accepted() {
        for reference in [
            "alpine:3.22".to_string(),
            "alpine".to_string(),
            format!("ghcr.io/example/app@{A}"),
            A.to_string(),
            "not a reference".to_string(),
        ] {
            let error = document([reference.as_str()]).unwrap_err();
            assert_eq!(error.code, "native_build_base_image", "{reference}");
            assert!(!error.message.contains(&reference), "{reference}");
        }
    }
}
