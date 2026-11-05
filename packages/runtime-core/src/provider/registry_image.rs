//! Digest-pinned image acquisition from any OCI distribution registry, without a Docker
//! daemon or VM effects.
//!
//! - **Registries.** Docker Hub, any public or private registry host reached over HTTPS,
//!   and local registries (loopback names, non-public IPv4 literals, single-label and
//!   `.local` hosts) only when the policy names them exactly. A `http://` opt-in is the
//!   only way to use plain HTTP.
//! - **Authentication.** Requests start anonymous. A `401` challenge is answered with an
//!   anonymous Bearer token first, and only then with the host user's existing Docker
//!   credentials (read-only; see `registry_credentials`). Credentials and tokens stay in
//!   zeroizing memory for one acquisition and never appear in output or errors. Only a
//!   challenge from the registry origin itself is answered, and credentials go only to
//!   the registry origin or a token realm on the registry's own host or a parent domain
//!   of it (Docker Hub: `auth.docker.io`).
//! - **Addresses.** Local and private destinations are refused by the address actually
//!   connected to, not only by host name: a custom resolver refuses names that resolve
//!   to loopback, private, link-local, CGNAT, multicast or unspecified addresses
//!   (including IPv4-mapped forms), and IP literals are checked before each request.
//!   Only an explicitly allowed local registry's own origin may reach such addresses.
//! - **Content.** OCI and Docker v2 indexes and manifests; gzip, zstd and uncompressed
//!   layers. Every manifest, config and layer is checked against its descriptor digest
//!   and size while streaming, and the assembled archive is validated again before it is
//!   published. Archive and expansion sizes stay within the policy's budgets.
//! - **Platform.** One unambiguous Linux ARM64 image.
use super::image_load;
use super::image_policy::ImagePolicy;
use super::image_reference::{ImageReference, NamedReference, normalize};
use super::registry_credentials::{self, Credential};
use crate::CandidateError;
use reqwest::{
    StatusCode, Url,
    blocking::{Client, Response},
    dns::{Addrs, Name, Resolve, Resolving},
    header::{ACCEPT, AUTHORIZATION, HeaderValue, LOCATION, WWW_AUTHENTICATE},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs},
    os::unix::fs::OpenOptionsExt,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const MAX_METADATA: usize = 1024 * 1024;
const MAX_TOKEN_RESPONSE: usize = 64 * 1024;
const MAX_TOKEN: usize = 32 * 1024;
const MAX_LAYERS: usize = 128;
/// Whole-acquisition deadline. It stays below the CLI's ten-minute bound for
/// `ensure-image` with room for the import that follows.
const ACQUISITION_DEADLINE: Duration = Duration::from_secs(360);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Slowest blob transfer rate a request timeout allows for before the deadline applies.
const MIN_BLOB_BYTES_PER_SECOND: u64 = 1024 * 1024;
const DOCKER_HUB: &str = "docker.io";
const DOCKER_HUB_ORIGIN: &str = "https://registry-1.docker.io";
const DOCKER_HUB_REALM: &str = "https://auth.docker.io/token";
const ACCEPT_MANIFEST: &str = "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json";
const INDEX_TYPES: [&str; 2] = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
];
const MANIFEST_TYPES: [&str; 2] = [
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
];
const CONFIG_TYPES: [&str; 2] = [
    "application/vnd.oci.image.config.v1+json",
    "application/vnd.docker.container.image.v1+json",
];

fn error(message: &str) -> CandidateError {
    CandidateError::new("registry_image", message)
}
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|v| {
        v.len() == 64
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn ipv4(host: &str) -> Option<[u8; 4]> {
    let mut octets = [0_u8; 4];
    let mut parts = host.split('.');
    for octet in &mut octets {
        let part = parts.next()?;
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *octet = part.parse().ok()?;
    }
    parts.next().is_none().then_some(octets)
}

fn public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..128).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..32).contains(&b))
        || (a == 192 && b == 168)
        || a >= 224)
}

/// Whether `ip` is a public unicast address. Loopback, unspecified, private (RFC 1918 and
/// IPv6 ULA `fc00::/7`), link-local (`169.254.0.0/16`, `fe80::/10`), deprecated
/// site-local (`fec0::/10`), CGNAT (`100.64.0.0/10`), multicast, broadcast and reserved
/// addresses are not, nor are IPv6 forms that embed such an IPv4 address (mapped,
/// compatible, NAT64 `64:ff9b::/96` and 6to4 `2002::/16`).
pub(super) fn public_ip(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V4(ip) => return public_ipv4(ip),
        IpAddr::V6(ip) => ip,
    };
    let segments = ip.segments();
    let embedded = |high: u16, low: u16| {
        Ipv4Addr::new((high >> 8) as u8, high as u8, (low >> 8) as u8, low as u8)
    };
    if let Some(v4) = ip.to_ipv4_mapped() {
        return public_ipv4(v4);
    }
    if segments[..6] == [0; 6] {
        // `::`, `::1` and the deprecated IPv4-compatible `::a.b.c.d`.
        return !ip.is_unspecified()
            && !ip.is_loopback()
            && public_ipv4(embedded(segments[6], segments[7]));
    }
    if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return public_ipv4(embedded(segments[6], segments[7]));
    }
    if segments[0] == 0x2002 {
        return public_ipv4(embedded(segments[1], segments[2]));
    }
    !(ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xffc0) == 0xfec0)
}

/// Hosts that are not public registries: loopback names, non-public IPv4 literals,
/// single-label names and mDNS `.local` names. They resolve on this host or its network,
/// so acquisition refuses them unless the policy names the registry explicitly. Public
/// names that merely resolve to local addresses are refused by [`GuardedResolver`].
pub(super) fn local_host(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    if let Some(octets) = ipv4(host) {
        return !public_ipv4(Ipv4Addr::from(octets));
    }
    !host.contains('.')
}

/// Host-name lookup used by [`GuardedResolver`]; tests inject a fixed table so no real
/// DNS is consulted.
pub(crate) type LookupFn = dyn Fn(&str) -> std::io::Result<Vec<IpAddr>> + Send + Sync;

/// An injectable host-name lookup for the registry client.
#[derive(Clone)]
pub(crate) struct HostLookup(pub(crate) Arc<LookupFn>);

impl std::fmt::Debug for HostLookup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HostLookup")
    }
}

fn system_lookup(host: &str) -> std::io::Result<Vec<IpAddr>> {
    Ok((host, 0)
        .to_socket_addrs()?
        .map(|address| address.ip())
        .collect())
}

/// A resolution refused because the name resolved to a local or private address.
#[derive(Debug)]
struct LocalAddressRefused;

impl std::fmt::Display for LocalAddressRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("registry host resolved to a local or private address")
    }
}

impl std::error::Error for LocalAddressRefused {}

fn local_address_refused() -> CandidateError {
    CandidateError::new(
        "registry_local_address",
        "A registry, redirect or token host resolved to a local or private network address; allow a local registry explicitly with --allow-local-registry.",
    )
}

/// The registry client's resolver. Every connection the client makes (registry origin,
/// redirects and token realms) resolves through it, so the local-address policy holds
/// for the address actually connected to. A name that resolves to any non-public address
/// is refused as a whole, except the host of an explicitly allowed local registry.
struct GuardedResolver {
    /// Lowercase host name of the explicitly allowed local registry being fetched.
    allowed_host: Option<String>,
    lookup: Arc<LookupFn>,
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_ascii_lowercase();
        let allowed = self.allowed_host.as_deref() == Some(host.as_str());
        let lookup = self.lookup.clone();
        Box::pin(async move {
            let addresses = tokio::task::spawn_blocking(move || lookup(&host)).await??;
            if addresses.is_empty() {
                return Err("registry host has no addresses".into());
            }
            if !allowed && !addresses.iter().all(|ip| public_ip(*ip)) {
                return Err(Box::new(LocalAddressRefused) as _);
            }
            let addresses: Addrs = Box::new(
                addresses
                    .into_iter()
                    .map(|ip| SocketAddr::new(ip, 0))
                    .collect::<Vec<_>>()
                    .into_iter(),
            );
            Ok(addresses)
        })
    }
}

/// A transport failure, naming a local-address refusal when the resolver made one.
fn transport_error(failure: &reqwest::Error, message: &str) -> CandidateError {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(failure);
    while let Some(cause) = source {
        if cause.is::<LocalAddressRefused>() {
            return local_address_refused();
        }
        source = cause.source();
    }
    error(message)
}

/// The reference grammar's `host[:port]` syntax, for local registry opt-ins.
pub(super) fn local_domain_syntax(domain: &str) -> Result<(), ()> {
    super::image_reference::domain(domain).map_err(|_| ())
}

/// Where one registry is reached.
#[derive(Clone, Debug)]
pub(super) struct Registry {
    /// Normalized reference domain, for example `docker.io` or `registry.test:5000`.
    domain: String,
    /// `scheme://host[:port]` of the distribution API.
    origin: Url,
    /// True when the policy explicitly allows this registry as a local registry; only
    /// then may its own origin reach local or private addresses.
    local: bool,
}

impl Registry {
    fn docker_hub(&self) -> bool {
        self.domain == DOCKER_HUB
    }
}

fn registry(named: &NamedReference, policy: &ImagePolicy) -> Result<Registry, CandidateError> {
    if named.domain == DOCKER_HUB {
        if named.docker_hub_repository().is_none() {
            return Err(error(
                "Docker Hub references must name a [namespace/]repository.",
            ));
        }
        return Ok(Registry {
            domain: DOCKER_HUB.into(),
            origin: Url::parse(DOCKER_HUB_ORIGIN).map_err(|_| error("Invalid registry origin."))?,
            local: false,
        });
    }
    let host = named.domain.split(':').next().unwrap_or_default();
    let opt_in = policy.local_registry(&named.domain);
    if local_host(host) && opt_in.is_none() {
        return Err(error(
            "Local registries are refused unless explicitly allowed for native image acquisition.",
        ));
    }
    let scheme = if opt_in.is_some_and(|r| r.plain_http) {
        "http"
    } else {
        "https"
    };
    let origin = Url::parse(&format!("{scheme}://{}", named.domain))
        .map_err(|_| error("Invalid registry origin."))?;
    // URL parsing normalizes numeric host forms (for example hexadecimal IPv4), so the
    // parsed host is classified too.
    if origin.host_str().is_none_or(local_host) && opt_in.is_none() {
        return Err(error(
            "Local registries are refused unless explicitly allowed for native image acquisition.",
        ));
    }
    Ok(Registry {
        domain: named.domain.clone(),
        origin,
        local: opt_in.is_some(),
    })
}

fn named(value: &str) -> Result<NamedReference, CandidateError> {
    match normalize(value) {
        Ok(ImageReference::Named(named)) => Ok(named),
        Ok(ImageReference::ImageId(_)) => Err(error(
            "A registry repository reference is required, not an image ID.",
        )),
        Err(reason) => Err(error(reason.message())),
    }
}

/// A digest-pinned registry reference ready for acquisition.
pub(super) struct Pinned {
    registry: Registry,
    path: String,
    digest: String,
}

impl Pinned {
    /// Canonical `domain/path@sha256:...`; any tag beside the digest is dropped.
    pub(super) fn canonical(&self) -> String {
        format!("{}/{}@{}", self.registry.domain, self.path, self.digest)
    }
}

/// Canonical `domain/path@digest` for a pinned reference, by syntax alone. It does not
/// admit the registry, so recorded cache entries stay readable under any policy.
pub(super) fn pinned_syntax(value: &str) -> Result<(String, String), CandidateError> {
    let pinned = || error("A registry reference pinned with @sha256 is required.");
    if !value.contains('@') {
        return Err(pinned());
    }
    let named = named(value)?;
    let digest = named.digest.ok_or_else(pinned)?;
    Ok((format!("{}/{}@{digest}", named.domain, named.path), digest))
}

/// A pinned reference whose registry the policy admits. Docker shorthand such as
/// `alpine@sha256:...` expands to `docker.io/library/alpine`.
pub(super) fn pinned(value: &str, policy: &ImagePolicy) -> Result<Pinned, CandidateError> {
    pinned_syntax(value)?;
    let named = named(value)?;
    Ok(Pinned {
        registry: registry(&named, policy)?,
        path: named.path,
        digest: named.digest.unwrap_or_default(),
    })
}

/// Registry, repository path and tag for mutable resolution. `alpine` is
/// `docker.io/library/alpine:latest`.
pub(super) fn tagged(
    value: &str,
    policy: &ImagePolicy,
) -> Result<(Registry, String, String), CandidateError> {
    if value.contains('@') {
        return Err(error(
            "Tag resolution requires a repository and optional tag, not a digest.",
        ));
    }
    let named = named(value)?;
    let registry = registry(&named, policy)?;
    Ok((
        registry,
        named.path,
        named.tag.unwrap_or_else(|| "latest".into()),
    ))
}

#[derive(Clone, Deserialize)]
struct Descriptor {
    digest: String,
    size: u64,
    #[serde(rename = "mediaType", default)]
    media_type: String,
    platform: Option<Platform>,
    #[serde(default)]
    urls: Vec<String>,
}
#[derive(Clone, Deserialize)]
struct Platform {
    os: String,
    architecture: String,
    variant: Option<String>,
}
#[derive(Deserialize)]
struct Manifest {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    #[serde(rename = "mediaType")]
    media_type: Option<String>,
    #[serde(default)]
    manifests: Vec<Descriptor>,
    config: Option<Descriptor>,
    #[serde(default)]
    layers: Vec<Descriptor>,
}
fn parse_manifest(bytes: &[u8], expected: &str) -> Result<Manifest, CandidateError> {
    if bytes.len() > MAX_METADATA || digest(bytes) != expected {
        return Err(error("Registry manifest digest or size mismatch."));
    }
    let m: Manifest =
        serde_json::from_slice(bytes).map_err(|_| error("Invalid registry manifest."))?;
    if m.schema_version != 2 {
        return Err(error("Unsupported registry manifest schema."));
    }
    let index = !m.manifests.is_empty();
    if m.media_type.as_deref().is_some_and(|t| {
        !(if index {
            INDEX_TYPES.contains(&t)
        } else {
            MANIFEST_TYPES.contains(&t)
        })
    }) {
        return Err(error("Unsupported registry manifest media type."));
    }
    Ok(m)
}
fn arm64(m: &Manifest) -> Result<&Descriptor, CandidateError> {
    let mut selected = m.manifests.iter().filter(|d| {
        d.platform.as_ref().is_some_and(|p| {
            p.os == "linux"
                && p.architecture == "arm64"
                && p.variant.as_deref().is_none_or(|v| v == "v8")
        })
    });
    let first = selected
        .next()
        .ok_or_else(|| error("Pinned index has no Linux ARM64 image."))?;
    if selected.next().is_some() {
        return Err(error("Pinned index has ambiguous Linux ARM64 images."));
    }
    if !first.media_type.is_empty() && !MANIFEST_TYPES.contains(&first.media_type.as_str()) {
        return Err(error(
            "The Linux ARM64 index entry is not an image manifest.",
        ));
    }
    Ok(first)
}
fn bounded(mut reader: impl Read, limit: usize) -> Result<Vec<u8>, CandidateError> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("Registry transfer failed or timed out."))?;
    if bytes.len() > limit {
        return Err(error("Registry response exceeds its byte limit."));
    }
    Ok(bytes)
}
/// Docker Hub serves blobs only from these HTTPS origins.
fn docker_hub_redirect_allowed(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|h| {
            h == "registry-1.docker.io"
                || h == "production.cloudflare.docker.com"
                || h == "production.cloudfront.docker.com"
                || h.ends_with(".r2.cloudflarestorage.com")
        })
}
/// The IP address of a URL whose host is an IP literal.
fn literal_ip(url: &Url) -> Option<IpAddr> {
    let host = url.host_str()?;
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
        .parse()
        .ok()
}

/// The lowercase host name of a URL whose host is a domain, not an IP literal.
fn domain_host(url: &Url) -> Option<&str> {
    url.host_str().filter(|_| literal_ip(url).is_none())
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

#[cfg(test)]
thread_local! {
    /// Loopback fixture origins that tests treat as public HTTPS hosts, so redirect and
    /// realm handling for foreign hosts can be exercised without TLS or public networks.
    pub(super) static TEST_PUBLIC_ORIGINS: std::cell::RefCell<Vec<Url>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

fn test_public_origin(_url: &Url) -> bool {
    #[cfg(test)]
    {
        TEST_PUBLIC_ORIGINS.with(|origins| origins.borrow().iter().any(|o| same_origin(o, _url)))
    }
    #[cfg(not(test))]
    {
        false
    }
}

/// A public HTTPS origin on port 443 without embedded credentials: not a local name, an
/// IPv6 literal or a non-public IPv4 literal.
fn public_https_origin(url: &Url) -> bool {
    if test_public_origin(url) {
        return true;
    }
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|host| !host.starts_with('[') && !local_host(host))
}
/// Redirect policy: the registry's own origin, Docker Hub's known blob origins, or for
/// other registries any public HTTPS origin on port 443 (registries commonly serve blobs
/// from object storage). Local destinations and embedded credentials always refuse.
fn redirect_allowed(registry: &Registry, url: &Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if same_origin(&registry.origin, url) {
        return true;
    }
    if registry.docker_hub() {
        return docker_hub_redirect_allowed(url);
    }
    public_https_origin(url)
}

/// A token realm may receive an anonymous token request when it is the registry origin
/// itself or a public HTTPS endpoint; Docker Hub's realm is fixed. See
/// [`credential_realm_allowed`] for realms that may receive credentials.
fn realm_allowed(registry: &Registry, realm: &Url) -> bool {
    if !realm.username().is_empty() || realm.password().is_some() {
        return false;
    }
    if registry.docker_hub() {
        return realm.as_str() == DOCKER_HUB_REALM;
    }
    same_origin(&registry.origin, realm) || public_https_origin(realm)
}

/// A token realm that may receive the host user's Docker credentials (a Basic header or
/// an identity refresh token). Docker Hub's realm is fixed to `auth.docker.io`. For other
/// registries the realm must be the registry origin, or HTTPS on port 443 at the
/// registry's own host name or a parent domain of it with at least two labels (for
/// example `gitlab.com` for `registry.gitlab.com`): whoever controls a parent domain can
/// already direct the registry's own name. Sibling hosts, unrelated hosts and IP
/// literals never receive credentials; without a public-suffix list a shared registrable
/// domain cannot be proven, so it is not assumed.
fn credential_realm_allowed(registry: &Registry, realm: &Url) -> bool {
    if !realm_allowed(registry, realm) {
        return false;
    }
    if registry.docker_hub() || same_origin(&registry.origin, realm) {
        return true;
    }
    let (Some(realm_host), Some(registry_host)) =
        (domain_host(realm), domain_host(&registry.origin))
    else {
        return false;
    };
    realm.scheme() == "https"
        && realm.port_or_known_default() == Some(443)
        && realm_host.contains('.')
        && (registry_host == realm_host
            || registry_host
                .strip_suffix(realm_host)
                .is_some_and(|prefix| prefix.ends_with('.')))
}

/// One `WWW-Authenticate` challenge: scheme and parameters.
struct Challenge {
    bearer: bool,
    realm: Option<String>,
    service: Option<String>,
}

fn parse_challenge(header: &str) -> Result<Challenge, CandidateError> {
    let invalid = || error("Unsupported registry authentication challenge.");
    let (scheme, rest) = header.trim().split_once(' ').unwrap_or((header.trim(), ""));
    let bearer = if scheme.eq_ignore_ascii_case("bearer") {
        true
    } else if scheme.eq_ignore_ascii_case("basic") {
        false
    } else {
        return Err(invalid());
    };
    let (mut realm, mut service) = (None, None);
    let mut chars = rest.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| *c == ',' || c.is_whitespace()) {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        let key: String = chars.by_ref().take_while(|c| *c != '=').collect();
        let mut value = String::new();
        if chars.peek() == Some(&'"') {
            chars.next();
            loop {
                match chars.next().ok_or_else(invalid)? {
                    '"' => break,
                    '\\' => value.push(chars.next().ok_or_else(invalid)?),
                    c => value.push(c),
                }
            }
        } else {
            while let Some(c) = chars.peek().copied().filter(|c| *c != ',') {
                value.push(c);
                chars.next();
            }
        }
        if value.len() > 2048 {
            return Err(invalid());
        }
        match key.trim().to_ascii_lowercase().as_str() {
            "realm" => realm = Some(value),
            "service" => service = Some(value),
            _ => {}
        }
    }
    Ok(Challenge {
        bearer,
        realm,
        service,
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Anonymous,
    AnonymousToken,
    Credentialed,
}

struct Fetch<'a> {
    client: Client,
    registry: Registry,
    path: String,
    policy: &'a ImagePolicy,
    /// Complete `Authorization` value sent to the registry origin only.
    authorization: Option<Zeroizing<String>>,
    stage: Stage,
    deadline: Instant,
}

impl<'a> Fetch<'a> {
    fn new(
        registry: &Registry,
        path: &str,
        policy: &'a ImagePolicy,
    ) -> Result<Self, CandidateError> {
        let resolver = GuardedResolver {
            allowed_host: registry
                .local
                .then(|| domain_host(&registry.origin).map(str::to_ascii_lowercase))
                .flatten(),
            lookup: policy
                .host_lookup
                .as_ref()
                .map_or_else(|| Arc::new(system_lookup) as Arc<LookupFn>, |l| l.0.clone()),
        };
        // One client serves every request of the acquisition (registry origin, redirects
        // and token realms), so the resolver and the destination check cover them all.
        let client = Client::builder()
            .https_only(registry.origin.scheme() == "https")
            .no_proxy()
            .redirect(Policy::none())
            .dns_resolver(Arc::new(resolver))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| error("Cannot initialize registry TLS client."))?;
        Ok(Self {
            client,
            registry: registry.clone(),
            path: path.to_owned(),
            policy,
            authorization: None,
            stage: Stage::Anonymous,
            deadline: Instant::now() + ACQUISITION_DEADLINE,
        })
    }

    fn remaining(&self) -> Result<Duration, CandidateError> {
        self.deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| error("Registry acquisition deadline exceeded."))
    }

    fn url(&self, kind: &str, reference: &str) -> Result<Url, CandidateError> {
        self.registry
            .origin
            .join(&format!("/v2/{}/{kind}/{reference}", self.path))
            .map_err(|_| error("Invalid registry object address."))
    }

    /// Whether a request may be sent to `url` by address: an IP literal must be public
    /// (the resolver is not consulted for literals), except an explicitly allowed local
    /// registry's own origin. That registry's host name is accepted only at its origin.
    fn destination_allowed(&self, url: &Url) -> bool {
        if test_public_origin(url) {
            return true;
        }
        let origin = same_origin(&self.registry.origin, url);
        if self.registry.local && origin {
            return true;
        }
        match (literal_ip(url), url.host_str()) {
            (Some(ip), _) => public_ip(ip),
            (None, Some(host)) => {
                origin || !self.registry.local || self.registry.origin.host_str() != Some(host)
            }
            (None, None) => false,
        }
    }

    /// One request with redirects followed under [`redirect_allowed`]. Authorization is
    /// attached only while the request targets the registry origin.
    fn send(&self, mut url: Url, timeout: Duration) -> Result<Response, CandidateError> {
        for hop in 0..=4 {
            if !self.destination_allowed(&url) {
                return Err(local_address_refused());
            }
            let mut request = self
                .client
                .get(url.clone())
                .timeout(self.remaining()?.min(timeout))
                .header(ACCEPT, ACCEPT_MANIFEST);
            if let Some(value) = self
                .authorization
                .as_ref()
                .filter(|_| same_origin(&self.registry.origin, &url))
            {
                let mut header = HeaderValue::from_str(value)
                    .map_err(|_| error("Invalid registry authorization."))?;
                header.set_sensitive(true);
                request = request.header(AUTHORIZATION, header);
            }
            let response = request
                .send()
                .map_err(|e| transport_error(&e, "Registry request failed or timed out."))?;
            if !response.status().is_redirection() {
                return Ok(response);
            }
            if hop == 4 {
                break;
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| error("Invalid registry redirect."))?;
            let next = url
                .join(location)
                .map_err(|_| error("Invalid registry redirect."))?;
            if !redirect_allowed(&self.registry, &next) {
                return Err(error("Registry redirect destination is not supported."));
            }
            url = next;
        }
        Err(error("Registry redirect limit exceeded."))
    }

    /// A successful response for `url`, answering at most two authentication challenges:
    /// anonymously first, then with the host user's Docker credentials. Only a challenge
    /// from the registry origin itself is answered; a redirected host that refuses access
    /// fails without any token or credential request.
    fn get(&mut self, url: Url, timeout: Duration) -> Result<Response, CandidateError> {
        loop {
            let response = self.send(url.clone(), timeout)?;
            let status = response.status();
            if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
                && !same_origin(&self.registry.origin, response.url())
            {
                return Err(CandidateError::new(
                    "registry_redirect_refused",
                    "A redirected registry storage host refused access; authentication is answered only for the registry origin.",
                ));
            }
            if status == StatusCode::UNAUTHORIZED && self.stage != Stage::Credentialed {
                let challenge = response
                    .headers()
                    .get(WWW_AUTHENTICATE)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| error("Registry requires authentication without a challenge."))
                    .and_then(parse_challenge)?;
                self.authorize(&challenge)?;
                continue;
            }
            return match status {
                s if s.is_success() => Ok(response),
                StatusCode::NOT_FOUND => Err(CandidateError::new(
                    "registry_image_not_found",
                    "The registry image or requested tag was not found.",
                )),
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(error(
                    "The registry refused access with the Docker credentials configured for it.",
                )),
                StatusCode::TOO_MANY_REQUESTS => Err(error(
                    "The registry rate-limited this request; retry later or configure credentials.",
                )),
                _ => Err(error("The registry request was refused.")),
            };
        }
    }

    /// Advance one authentication stage for `challenge`, which came from the registry
    /// origin. Credentials are looked up only after the realm that would receive them
    /// passes [`credential_realm_allowed`].
    fn authorize(&mut self, challenge: &Challenge) -> Result<(), CandidateError> {
        let credentialed = self.stage == Stage::AnonymousToken || !challenge.bearer;
        let realm = if challenge.bearer {
            let realm = challenge
                .realm
                .as_deref()
                .and_then(|r| Url::parse(r).ok())
                .filter(|r| realm_allowed(&self.registry, r))
                .ok_or_else(|| error("The registry token endpoint is not supported."))?;
            if credentialed && !credential_realm_allowed(&self.registry, &realm) {
                self.stage = Stage::Credentialed;
                return Err(CandidateError::new(
                    "registry_realm_refused",
                    "The registry token endpoint is not on the registry's own host or a parent domain, so Docker credentials are not sent to it.",
                ));
            }
            Some(realm)
        } else {
            None
        };
        let credential = if credentialed {
            self.stage = Stage::Credentialed;
            Some(
                registry_credentials::lookup(self.policy, &self.registry.domain)?.ok_or_else(
                    || {
                        error(
                            "The registry requires credentials; none are configured for it in the Docker configuration.",
                        )
                    },
                )?,
            )
        } else {
            self.stage = Stage::AnonymousToken;
            None
        };
        if !challenge.bearer {
            let basic = credential
                .as_ref()
                .and_then(Credential::basic_header)
                .ok_or_else(|| error("The registry requires username and password credentials."))?;
            self.authorization = Some(basic);
            return Ok(());
        }
        let realm = realm.ok_or_else(|| error("The registry token endpoint is not supported."))?;
        let token = match self.token(&realm, challenge.service.as_deref(), credential.as_ref()) {
            Err(failure) if credential.is_none() && failure.code == "registry_token_refused" => {
                // An endpoint that refuses anonymous tokens needs credentials.
                return self.authorize(challenge);
            }
            other => other?,
        };
        self.authorization = Some(Zeroizing::new(format!("Bearer {}", token.as_str())));
        Ok(())
    }

    fn token(
        &self,
        realm: &Url,
        service: Option<&str>,
        credential: Option<&Credential>,
    ) -> Result<Zeroizing<String>, CandidateError> {
        if !self.destination_allowed(realm) {
            return Err(local_address_refused());
        }
        let scope = format!("repository:{}:pull", self.path);
        let request = match credential {
            Some(Credential::IdentityToken(refresh)) => {
                let mut form = vec![
                    ("grant_type", "refresh_token"),
                    ("client_id", "hack"),
                    ("scope", scope.as_str()),
                    ("refresh_token", refresh.as_str()),
                ];
                if let Some(service) = service {
                    form.push(("service", service));
                }
                self.client.post(realm.clone()).form(&form)
            }
            basic => {
                let mut url = realm.clone();
                {
                    let mut query = url.query_pairs_mut();
                    if let Some(service) = service {
                        query.append_pair("service", service);
                    }
                    query.append_pair("scope", &scope);
                }
                let mut request = self.client.get(url);
                if let Some(value) = basic.and_then(Credential::basic_header) {
                    let mut header = HeaderValue::from_str(&value)
                        .map_err(|_| error("Invalid registry credentials."))?;
                    header.set_sensitive(true);
                    request = request.header(AUTHORIZATION, header);
                }
                request
            }
        };
        let response = request
            .timeout(self.remaining()?.min(REQUEST_TIMEOUT))
            .send()
            .map_err(|e| transport_error(&e, "Registry token request failed or timed out."))?;
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return Err(CandidateError::new(
                if credential.is_some() {
                    "registry_image"
                } else {
                    "registry_token_refused"
                },
                "The registry token endpoint refused the Docker credentials configured for it.",
            ));
        }
        if !response.status().is_success() {
            return Err(error("The registry token endpoint refused the request."));
        }
        #[derive(Deserialize)]
        struct Token {
            token: Option<String>,
            access_token: Option<String>,
        }
        let bytes = Zeroizing::new(bounded(response, MAX_TOKEN_RESPONSE)?);
        let mut parsed: Token = serde_json::from_slice(&bytes)
            .map_err(|_| error("Invalid registry token response."))?;
        let token = Zeroizing::new(
            parsed
                .token
                .take()
                .filter(|t| !t.is_empty())
                .or_else(|| parsed.access_token.take())
                .unwrap_or_default(),
        );
        if let Some(mut other) = parsed.access_token.take() {
            zeroize::Zeroize::zeroize(&mut other);
        }
        if token.is_empty()
            || token.len() > MAX_TOKEN
            || token.bytes().any(|b| b.is_ascii_control() || b == b' ')
        {
            return Err(error("Invalid registry token."));
        }
        Ok(token)
    }

    fn manifest(&mut self, reference: &str) -> Result<Vec<u8>, CandidateError> {
        let url = self.url("manifests", reference)?;
        let response = self.get(url, REQUEST_TIMEOUT)?;
        if response
            .content_length()
            .is_some_and(|n| n > MAX_METADATA as u64)
        {
            return Err(error("Registry response exceeds its byte limit."));
        }
        bounded(response, MAX_METADATA)
    }

    fn checked(d: &Descriptor, limit: u64) -> Result<(), CandidateError> {
        if !valid_digest(&d.digest) || d.size == 0 || d.size > limit || !d.urls.is_empty() {
            return Err(error(
                "Registry descriptor exceeds its identity or size limits.",
            ));
        }
        Ok(())
    }

    /// One small object (manifest or config) verified against its descriptor.
    fn object(&mut self, kind: &str, d: &Descriptor) -> Result<Vec<u8>, CandidateError> {
        Self::checked(d, MAX_METADATA as u64)?;
        let response = self.get(self.url(kind, &d.digest)?, REQUEST_TIMEOUT)?;
        let bytes = bounded(response, d.size as usize)?;
        verify_object(d, &bytes)?;
        Ok(bytes)
    }

    /// A layer blob as a reader that enforces its descriptor's exact size and digest.
    fn blob(&mut self, d: &Descriptor) -> Result<Verified<Response>, CandidateError> {
        let timeout = REQUEST_TIMEOUT + Duration::from_secs(d.size / MIN_BLOB_BYTES_PER_SECOND);
        let response = self.get(self.url("blobs", &d.digest)?, timeout)?;
        if response.content_length().is_some_and(|n| n != d.size) {
            return Err(error("Registry object digest or size mismatch."));
        }
        Ok(Verified {
            inner: response,
            digest: Sha256::new(),
            total: 0,
            size: d.size,
            expected: d.digest.clone(),
        })
    }
}

fn verify_object(descriptor: &Descriptor, bytes: &[u8]) -> Result<(), CandidateError> {
    if bytes.len() as u64 != descriptor.size || digest(bytes) != descriptor.digest {
        return Err(error("Registry object digest or size mismatch."));
    }
    Ok(())
}

/// Streams exactly `size` bytes and fails at their end unless they hash to `expected`;
/// a short, long or altered blob therefore cannot complete its archive member.
struct Verified<R> {
    inner: R,
    digest: Sha256,
    total: u64,
    size: u64,
    expected: String,
}
impl<R: Read> Read for Verified<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buffer)?;
        self.total += n as u64;
        if self.total > self.size {
            return Err(std::io::Error::other("blob exceeds its descriptor size"));
        }
        if n == 0 {
            let actual = format!("sha256:{:x}", std::mem::take(&mut self.digest).finalize());
            if self.total != self.size || actual != self.expected {
                return Err(std::io::Error::other("blob digest or size mismatch"));
            }
            return Ok(0);
        }
        self.digest.update(&buffer[..n]);
        Ok(n)
    }
}

/// Hashes and counts the archive as it is written.
struct HashingWriter<W> {
    inner: W,
    digest: Sha256,
    total: u64,
    limit: u64,
}
impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buffer)?;
        self.total += n as u64;
        if self.total > self.limit {
            return Err(std::io::Error::other("archive exceeds its budget"));
        }
        self.digest.update(&buffer[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn header(size: u64) -> tar::Header {
    let mut h = tar::Header::new_gnu();
    h.set_size(size);
    h.set_mode(0o600);
    h.set_cksum();
    h
}

/// Tar bytes for one member of `size`: header plus data padded to 512.
fn member_bytes(size: u64) -> u64 {
    512 + size.div_ceil(512) * 512
}

#[derive(Debug, Serialize)]
pub struct AcquiredImage {
    pub source_digest: String,
    pub manifest_digest: String,
    pub image_id: String,
    pub archive_sha256: String,
    pub archive_bytes: u64,
}

/// The admitted form of one authored image reference.
#[derive(Debug, Serialize)]
pub struct AdmittedImage {
    /// Canonical normalized reference, for example `docker.io/library/alpine:3.21`.
    pub reference: String,
    /// `image_id` for a local content ID, `docker_hub` for Docker Hub, `registry` for any
    /// other admitted registry.
    pub kind: &'static str,
}

/// Pure admission for one authored image reference. It normalizes Docker shorthand and
/// refuses anything the provider could not later acquire under `policy`, such as a local
/// registry that is not explicitly allowed. No network, credential, candidate state or
/// runtime effect occurs, so a caller can refuse before any VM or provider starts.
/// Acquisition re-normalizes with the same rules.
pub fn admit(value: &str, policy: &ImagePolicy) -> Result<AdmittedImage, CandidateError> {
    match normalize(value) {
        Ok(ImageReference::ImageId(id)) => Ok(AdmittedImage {
            reference: id,
            kind: "image_id",
        }),
        Ok(ImageReference::Named(named)) => {
            let registry = registry(&named, policy)?;
            Ok(AdmittedImage {
                reference: named.canonical(),
                kind: if registry.docker_hub() {
                    "docker_hub"
                } else {
                    "registry"
                },
            })
        }
        Err(reason) => Err(error(reason.message())),
    }
}

#[derive(Debug, Serialize)]
pub struct ResolvedImage {
    pub pinned_reference: String,
    pub source_digest: String,
    pub manifest_digest: String,
    pub image_id: String,
    pub platform: &'static str,
}

/// The selected single-image manifest and its digest, from an index or a manifest.
fn select(
    fetch: &mut Fetch<'_>,
    initial: &[u8],
    source_digest: &str,
) -> Result<(Manifest, String), CandidateError> {
    let mut manifest = parse_manifest(initial, source_digest)?;
    let mut manifest_digest = source_digest.to_owned();
    if !manifest.manifests.is_empty() {
        let selected = arm64(&manifest)?.clone();
        manifest_digest = selected.digest.clone();
        let bytes = fetch.object("manifests", &selected)?;
        manifest = parse_manifest(&bytes, &manifest_digest)?;
    }
    if !manifest.manifests.is_empty()
        || manifest.layers.is_empty()
        || manifest.layers.len() > MAX_LAYERS
    {
        return Err(error("Only a bounded single-image manifest is supported."));
    }
    let config = manifest
        .config
        .as_ref()
        .ok_or_else(|| error("Image config descriptor is missing."))?;
    if !config.media_type.is_empty() && !CONFIG_TYPES.contains(&config.media_type.as_str()) {
        return Err(error("The manifest does not describe a container image."));
    }
    Ok((manifest, manifest_digest))
}

/// Resolve mutable metadata once and return an explicit immutable identity. No image
/// layers, archive or runtime state are accessed; credentials are read only if the
/// registry challenges. A later fetch must use `pinned_reference`.
pub fn resolve(
    reference_text: &str,
    policy: &ImagePolicy,
) -> Result<ResolvedImage, CandidateError> {
    let (registry, path, tag) = tagged(reference_text, policy)?;
    let mut fetch = Fetch::new(&registry, &path, policy)?;
    let initial = fetch.manifest(&tag)?;
    let source_digest = digest(&initial);
    let (manifest, manifest_digest) = select(&mut fetch, &initial, &source_digest)?;
    let config = manifest
        .config
        .ok_or_else(|| error("Image config descriptor is missing."))?;
    let config_bytes = fetch.object("blobs", &config)?;
    verify_platform(&config_bytes)?;
    Ok(ResolvedImage {
        pinned_reference: format!("{}/{path}@{source_digest}", registry.domain),
        source_digest,
        manifest_digest,
        image_id: config.digest,
        platform: "linux/arm64",
    })
}
fn verify_platform(config_bytes: &[u8]) -> Result<(), CandidateError> {
    let config: serde_json::Value =
        serde_json::from_slice(config_bytes).map_err(|_| error("Invalid image configuration."))?;
    if config["os"] != "linux"
        || config["architecture"] != "arm64"
        || config.get("variant").is_some_and(|v| v != "v8")
    {
        return Err(error(
            "Image configuration does not target supported Linux ARM64.",
        ));
    }
    Ok(())
}

fn layer_extension(media_type: &str) -> Result<&'static str, CandidateError> {
    match media_type {
        "application/vnd.oci.image.layer.v1.tar+gzip"
        | "application/vnd.docker.image.rootfs.diff.tar.gzip" => Ok("tar.gz"),
        "application/vnd.oci.image.layer.v1.tar+zstd" => Ok("tar.zst"),
        "application/vnd.oci.image.layer.v1.tar"
        | "application/vnd.docker.image.rootfs.diff.tar" => Ok("tar"),
        _ => Err(error(
            "Only distributable gzip, zstd or uncompressed image layers are supported.",
        )),
    }
}

/// Acquire one pinned Linux ARM64 image into a new explicit archive of at most `limit`
/// bytes (and the policy's per-image budget). The output must not exist. A failure never
/// imports an image or changes candidate runtime state, and leaves no final archive.
/// The complete acquisition has a 360-second deadline; process cancellation stops it.
pub fn acquire(
    reference_text: &str,
    output: &Path,
    policy: &ImagePolicy,
    limit: u64,
) -> Result<AcquiredImage, CandidateError> {
    let pinned = pinned(reference_text, policy)?;
    let limit = limit.min(policy.archive_limit);
    if output.exists() {
        return Err(error("Image archive output already exists."));
    }
    let mut fetch = Fetch::new(&pinned.registry, &pinned.path, policy)?;
    let initial = fetch.manifest(&pinned.digest)?;
    let (manifest, manifest_digest) = select(&mut fetch, &initial, &pinned.digest)?;
    let config = manifest
        .config
        .clone()
        .ok_or_else(|| error("Image config descriptor is missing."))?;
    let config_bytes = fetch.object("blobs", &config)?;
    verify_platform(&config_bytes)?;
    let mut names = Vec::new();
    let mut planned = member_bytes(config.size) + member_bytes(64 * 1024) + 1024;
    for (i, layer) in manifest.layers.iter().enumerate() {
        names.push(format!("layer-{i}.{}", layer_extension(&layer.media_type)?));
        Fetch::checked(layer, super::image_policy::ARCHIVE_CEILING)?;
        planned = planned.saturating_add(member_bytes(layer.size));
    }
    // The manifest states every size, so an image beyond the budget refuses before any
    // layer transfer or disk write.
    if planned > limit {
        return Err(error(
            "The image exceeds the configured image budget or the remaining image cache budget.",
        ));
    }
    let config_name = format!("{}.json", config.digest.trim_start_matches("sha256:"));
    let deadline = fetch.deadline;
    let manifest_bytes = serde_json::to_vec(
        &serde_json::json!([{"Config":config_name,"Layers":names,"RepoTags":[]}]),
    )
    .map_err(|_| error("Cannot encode image archive metadata."))?;
    let written = publish(
        output,
        |file| {
            let mut builder = tar::Builder::new(HashingWriter {
                inner: file,
                digest: Sha256::new(),
                total: 0,
                limit,
            });
            let assemble = || error("Cannot assemble the image archive within its budget.");
            builder
                .append_data(
                    &mut header(config.size),
                    &config_name,
                    config_bytes.as_slice(),
                )
                .map_err(|_| assemble())?;
            for (layer, name) in manifest.layers.iter().zip(&names) {
                let mut blob = fetch.blob(layer)?;
                builder
                    .append_data(&mut header(layer.size), name, &mut blob)
                    .map_err(|_| {
                        error("A registry layer transfer failed or did not match its digest and size.")
                    })?;
            }
            builder
                .append_data(
                    &mut header(manifest_bytes.len() as u64),
                    "manifest.json",
                    manifest_bytes.as_slice(),
                )
                .map_err(|_| assemble())?;
            let writer = builder.into_inner().map_err(|_| assemble())?;
            Ok((format!("{:x}", writer.digest.finalize()), writer.total))
        },
        |temporary, (sha, total)| {
            if Instant::now() >= deadline {
                return Err(error("Registry acquisition deadline exceeded."));
            }
            if image_load::validate_file(temporary, sha, &config.digest, policy)? != *total {
                return Err(error(
                    "The assembled image archive changed before publication.",
                ));
            }
            Ok(())
        },
    )?;
    Ok(AcquiredImage {
        source_digest: pinned.digest,
        manifest_digest,
        image_id: config.digest,
        archive_sha256: written.0,
        archive_bytes: written.1,
    })
}

/// Write a new exclusive temporary file, sync and verify it, then link it into place
/// without replacing a competing output.
fn publish<T>(
    output: &Path,
    write: impl FnOnce(&mut File) -> Result<T, CandidateError>,
    verify: impl FnOnce(&Path, &T) -> Result<(), CandidateError>,
) -> Result<T, CandidateError> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temporary = parent.join(format!(
        ".hack-image-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)
        .map_err(|_| error("Cannot exclusively create the temporary image archive."))?;
    let result = (|| {
        let value = write(&mut file)?;
        file.sync_all()
            .map_err(|_| error("Image archive write failed before publication."))?;
        verify(&temporary, &value)?;
        fs::hard_link(&temporary, output).map_err(|_| {
            error("Cannot publish the image archive without replacing an existing output.")
        })?;
        fs::remove_file(&temporary).map_err(|_| {
            error("Complete image archive published; temporary link cleanup failed.")
        })?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| error("Complete image archive published; directory sync failed."))?;
        Ok(value)
    })();
    // Only the exclusive temporary path created by this call is ever removed.
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
#[path = "registry_image_test.rs"]
mod tests;
