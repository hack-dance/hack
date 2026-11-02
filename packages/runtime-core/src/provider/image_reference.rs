//! Pure OCI image reference normalization shared by plan admission and acquisition.
//!
//! Docker shorthand is expanded exactly as the Docker CLI does: an unqualified name
//! belongs to `docker.io`, a single Docker Hub path component gains `library/`,
//! the legacy `index.docker.io` domain becomes `docker.io`, and a reference with
//! neither tag nor digest gains `:latest`. Registries, ports, tags and digests are
//! otherwise kept exactly. No network, filesystem, credential or runtime state is read.
//!
//! Errors are a closed, value-free vocabulary: callers attach their own error code
//! and never echo the rejected input.

const MAX_INPUT: usize = 512;
/// Docker distribution's bound on a complete normalized repository name.
const MAX_NAME: usize = 255;
const MAX_TAG: usize = 128;
const DOCKER_HUB: &str = "docker.io";

/// A closed rejection reason. Messages never include the rejected reference.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReferenceError {
    Empty,
    TooLong,
    InvalidCharacters,
    InvalidDigest,
    InvalidImageId,
    InvalidDomain,
    UppercaseRepository,
    InvalidRepository,
    InvalidTag,
    NameTooLong,
}

impl ReferenceError {
    pub fn message(self) -> &'static str {
        match self {
            Self::Empty => "Image reference is empty.",
            Self::TooLong => "Image reference exceeds 512 bytes.",
            Self::InvalidCharacters => {
                "Image must be a literal OCI-style reference without URLs, credentials or whitespace."
            }
            Self::InvalidDigest => "Only lowercase sha256 image digests are supported.",
            Self::InvalidImageId => "Image IDs must be sha256 followed by 64 lowercase hex digits.",
            Self::InvalidDomain => "Image registry must be a lowercase host with an optional port.",
            Self::UppercaseRepository => "Image repository names must be lowercase.",
            Self::InvalidRepository => "Invalid image repository path.",
            Self::InvalidTag => {
                "Image tags must be 1 to 128 word characters, '.' or '-', not starting with '.' or '-'."
            }
            Self::NameTooLong => "Normalized image name exceeds 255 bytes.",
        }
    }
}

/// A fully qualified registry reference.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NamedReference {
    /// Registry host with optional port, for example `docker.io` or `localhost:5000`.
    pub domain: String,
    /// Repository path below the registry, for example `library/alpine`.
    pub path: String,
    /// Present unless the reference is pinned by digest alone.
    pub tag: Option<String>,
    /// `sha256:<64 lowercase hex>` when pinned.
    pub digest: Option<String>,
}

impl NamedReference {
    /// The canonical `domain/path[:tag][@digest]` form.
    pub fn canonical(&self) -> String {
        let mut value = format!("{}/{}", self.domain, self.path);
        if let Some(tag) = &self.tag {
            value.push(':');
            value.push_str(tag);
        }
        if let Some(digest) = &self.digest {
            value.push('@');
            value.push_str(digest);
        }
        value
    }

    /// The `namespace/repository` path when this is a public Docker Hub reference
    /// the anonymous acquisition path supports, otherwise `None`.
    pub fn docker_hub_repository(&self) -> Option<&str> {
        (self.domain == DOCKER_HUB && self.path.len() <= 200 && self.path.split('/').count() == 2)
            .then_some(self.path.as_str())
    }
}

/// A normalized image reference: a registry name or an already-local immutable image ID.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ImageReference {
    /// `sha256:<64 lowercase hex>` content ID that needs no registry resolution.
    ImageId(String),
    Named(NamedReference),
}

impl ImageReference {
    pub fn canonical(&self) -> String {
        match self {
            Self::ImageId(id) => id.clone(),
            Self::Named(named) => named.canonical(),
        }
    }
}

fn lowercase_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn sha256(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(|hex| lowercase_hex(hex, 64))
}

/// `[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*`, distribution's path component grammar.
fn path_component(value: &str) -> Result<(), ReferenceError> {
    if value.bytes().any(|b| b.is_ascii_uppercase()) {
        return Err(ReferenceError::UppercaseRepository);
    }
    let bytes = value.as_bytes();
    let alphanumeric =
        |b: Option<&u8>| b.is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    let mut cursor = 0;
    loop {
        let start = cursor;
        while alphanumeric(bytes.get(cursor)) {
            cursor += 1;
        }
        if start == cursor {
            return Err(ReferenceError::InvalidRepository);
        }
        if cursor == bytes.len() {
            return Ok(());
        }
        match bytes[cursor] {
            b'.' => cursor += 1,
            b'_' => {
                cursor += 1;
                if bytes.get(cursor) == Some(&b'_') {
                    cursor += 1;
                }
            }
            b'-' => {
                while bytes.get(cursor) == Some(&b'-') {
                    cursor += 1;
                }
            }
            _ => return Err(ReferenceError::InvalidRepository),
        }
    }
}

/// Lowercase DNS-style host labels, optionally followed by a decimal port in 1..=65535.
fn domain(value: &str) -> Result<(), ReferenceError> {
    let (host, port) = match value.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (value, None),
    };
    if let Some(port) = port {
        if port.is_empty()
            || !port.bytes().all(|b| b.is_ascii_digit())
            || port.parse::<u16>().ok().filter(|p| *p > 0).is_none()
        {
            return Err(ReferenceError::InvalidDomain);
        }
    }
    let label = |label: &str| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    };
    if host.is_empty() || !host.split('.').all(label) {
        return Err(ReferenceError::InvalidDomain);
    }
    Ok(())
}

fn tag(value: &str) -> Result<(), ReferenceError> {
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    if value.is_empty()
        || value.len() > MAX_TAG
        || !value.bytes().next().is_some_and(word)
        || !value.bytes().all(|b| word(b) || b == b'.' || b == b'-')
    {
        return Err(ReferenceError::InvalidTag);
    }
    Ok(())
}

/// Normalize one authored image reference. Pure and deterministic; the result's
/// canonical form normalizes to itself.
pub fn normalize(value: &str) -> Result<ImageReference, ReferenceError> {
    if value.is_empty() {
        return Err(ReferenceError::Empty);
    }
    if value.len() > MAX_INPUT {
        return Err(ReferenceError::TooLong);
    }
    if value.contains("://")
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-/:@".contains(&b))
    {
        return Err(ReferenceError::InvalidCharacters);
    }
    // A bare content ID is not Docker Hub shorthand for a repository named sha256.
    if let Some(id) = value.strip_prefix("sha256:") {
        if value.contains('/') || value.contains('@') || !lowercase_hex(id, 64) {
            return Err(ReferenceError::InvalidImageId);
        }
        return Ok(ImageReference::ImageId(value.into()));
    }
    let (name, digest) = match value.split_once('@') {
        Some((name, digest)) => {
            if !sha256(digest) {
                return Err(ReferenceError::InvalidDigest);
            }
            (name, Some(digest.to_owned()))
        }
        None => (value, None),
    };
    // Docker treats the first component as a registry only when it looks like a
    // host (contains '.' or ':', or is localhost) and more components follow.
    let (registry, remainder) = match name.split_once('/') {
        Some((first, rest))
            if first.contains('.')
                || first.contains(':')
                || first == "localhost"
                || first.bytes().any(|b| b.is_ascii_uppercase()) =>
        {
            domain(first)?;
            (first, rest)
        }
        _ => (DOCKER_HUB, name),
    };
    let (path, tag_value) = match remainder.rsplit_once(':') {
        Some((path, value)) => {
            tag(value)?;
            (path, Some(value))
        }
        None => (remainder, None),
    };
    if path.is_empty() {
        return Err(ReferenceError::InvalidRepository);
    }
    for component in path.split('/') {
        path_component(component)?;
    }
    let registry = if registry == "index.docker.io" {
        DOCKER_HUB
    } else {
        registry
    };
    let path = if registry == DOCKER_HUB && !path.contains('/') {
        format!("library/{path}")
    } else {
        path.to_owned()
    };
    if registry.len() + 1 + path.len() > MAX_NAME {
        return Err(ReferenceError::NameTooLong);
    }
    let tag = match (tag_value, &digest) {
        (Some(value), _) => Some(value.to_owned()),
        (None, None) => Some("latest".to_owned()),
        (None, Some(_)) => None,
    };
    Ok(ImageReference::Named(NamedReference {
        domain: registry.to_owned(),
        path,
        tag,
        digest,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical(value: &str) -> String {
        normalize(value).unwrap().canonical()
    }

    #[test]
    fn docker_hub_shorthand_expands_like_the_docker_cli() {
        let pin = format!("sha256:{}", "a".repeat(64));
        for (input, expected) in [
            ("alpine", "docker.io/library/alpine:latest".to_owned()),
            ("alpine:3.21", "docker.io/library/alpine:3.21".to_owned()),
            ("user/img", "docker.io/user/img:latest".to_owned()),
            (
                "user/img:1.0-rc_1",
                "docker.io/user/img:1.0-rc_1".to_owned(),
            ),
            (
                "docker.io/alpine",
                "docker.io/library/alpine:latest".to_owned(),
            ),
            (
                "docker.io/library/alpine:3.21",
                "docker.io/library/alpine:3.21".to_owned(),
            ),
            (
                "index.docker.io/user/img",
                "docker.io/user/img:latest".to_owned(),
            ),
            (
                "postgres:16-alpine",
                "docker.io/library/postgres:16-alpine".to_owned(),
            ),
            (
                "a__b-c/e---f.g:TAG_upper",
                "docker.io/a__b-c/e---f.g:TAG_upper".to_owned(),
            ),
            // Without a slash, host-like text is a Docker Hub repository and tag.
            (
                "registry.test:5000",
                "docker.io/library/registry.test:5000".to_owned(),
            ),
            // Digests are kept and do not gain an implicit tag.
            (
                &*format!("alpine@{pin}"),
                format!("docker.io/library/alpine@{pin}"),
            ),
            (
                &*format!("alpine:3.21@{pin}"),
                format!("docker.io/library/alpine:3.21@{pin}"),
            ),
            (
                &*format!("user/img@{pin}"),
                format!("docker.io/user/img@{pin}"),
            ),
            // Registries, ports and nested paths are preserved verbatim.
            ("ghcr.io/org/app:v1", "ghcr.io/org/app:v1".to_owned()),
            ("localhost/app", "localhost/app:latest".to_owned()),
            ("localhost:5000/app", "localhost:5000/app:latest".to_owned()),
            (
                "registry.test:5000/team/sub/app:1",
                "registry.test:5000/team/sub/app:1".to_owned(),
            ),
            (
                "registry.test:5000/app",
                "registry.test:5000/app:latest".to_owned(),
            ),
            (
                &*format!("registry.test:5000/app@{pin}"),
                format!("registry.test:5000/app@{pin}"),
            ),
            (
                &*format!("registry.test:5000/app:v2@{pin}"),
                format!("registry.test:5000/app:v2@{pin}"),
            ),
        ] {
            assert_eq!(canonical(input), expected, "{input}");
            assert_eq!(canonical(&expected), expected, "idempotent {expected}");
        }
        let id = format!("sha256:{}", "e".repeat(64));
        assert_eq!(normalize(&id).unwrap(), ImageReference::ImageId(id.clone()));
    }

    #[test]
    fn invalid_references_refuse_with_closed_value_free_reasons() {
        use ReferenceError::*;
        let long_path = format!("{}/{}", "a".repeat(200), "b".repeat(60));
        let long_tag = format!("alpine:{}", "t".repeat(129));
        let cases: Vec<(String, ReferenceError)> = vec![
            ("".into(), Empty),
            ("a".repeat(513), TooLong),
            (long_path, NameTooLong),
            (long_tag, InvalidTag),
            ("Alpine".into(), UppercaseRepository),
            ("user/Img:1".into(), UppercaseRepository),
            ("Registry.Test/app".into(), InvalidDomain),
            ("REGISTRY/app".into(), InvalidDomain),
            ("registry.test:0/app".into(), InvalidDomain),
            ("registry.test:65536/app".into(), InvalidDomain),
            ("registry.test:/app".into(), InvalidDomain),
            ("registry.test:50a/app".into(), InvalidDomain),
            ("-bad.test/app".into(), InvalidDomain),
            ("https://docker.io/a/b".into(), InvalidCharacters),
            ("a/b:PRIVATE CANARY".into(), InvalidCharacters),
            ("a/b:foo?bar".into(), InvalidCharacters),
            ("user:secret@docker.io/a/b".into(), InvalidDigest),
            ("alpine@sha256:bad".into(), InvalidDigest),
            (format!("alpine@sha256:{}", "A".repeat(64)), InvalidDigest),
            (format!("alpine@sha512:{}", "a".repeat(128)), InvalidDigest),
            ("sha256:abc".into(), InvalidImageId),
            (format!("sha256:{}", "E".repeat(64)), InvalidImageId),
            ("a/b:".into(), InvalidTag),
            ("a/b:-bad".into(), InvalidTag),
            ("a/b:.bad".into(), InvalidTag),
            ("a/..:tag".into(), InvalidRepository),
            ("../bad".into(), InvalidDomain),
            ("a//b".into(), InvalidRepository),
            ("a/b/".into(), InvalidRepository),
            ("bad-/x".into(), InvalidRepository),
            ("a_-b".into(), InvalidRepository),
            ("a___b".into(), InvalidRepository),
            ("registry.test:5000/".into(), InvalidRepository),
            ("registry.test/".into(), InvalidRepository),
        ];
        for (input, reason) in cases {
            assert_eq!(normalize(&input), Err(reason), "{input}");
            assert!(!reason.message().contains(&input) || input.is_empty());
        }
    }

    #[test]
    fn only_two_component_docker_hub_paths_are_acquirable() {
        let named = |value: &str| match normalize(value).unwrap() {
            ImageReference::Named(named) => named,
            ImageReference::ImageId(_) => panic!("named"),
        };
        assert_eq!(
            named("alpine").docker_hub_repository(),
            Some("library/alpine")
        );
        assert_eq!(
            named("user/img:1").docker_hub_repository(),
            Some("user/img")
        );
        for value in [
            "ghcr.io/org/app",
            "localhost:5000/app",
            "a/b/c",
            "docker.io/a/b/c",
        ] {
            assert_eq!(named(value).docker_hub_repository(), None, "{value}");
        }
        let long = format!("docker.io/{}/b", "a".repeat(199));
        assert_eq!(named(&long).docker_hub_repository(), None);
    }
}
