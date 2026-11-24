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
//!   to any address that is not globally reachable unicast (loopback, private,
//!   link-local, CGNAT, benchmarking, documentation, multicast, reserved and every other
//!   special-purpose block, including embedded IPv4 forms), and IP literals are checked
//!   before each request. Only an explicitly allowed local registry's own origin may
//!   reach such addresses.
//! - **Content.** OCI and Docker v2 indexes and manifests; gzip, zstd and uncompressed
//!   layers. Every manifest, config and layer is checked against its descriptor digest
//!   and size while streaming, and the assembled archive is validated again before it is
//!   published. Archive and expansion sizes stay within the policy's budgets.
//! - **Platform.** One unambiguous Linux ARM64 image by default; an explicit platform
//!   policy may select Linux AMD64 instead (see `image_platform`).
use super::go_json::GoJson;
use super::image_load;
use super::image_platform::{ImagePlatform, PlatformPolicy};
use super::image_policy::ImagePolicy;
use super::image_reference::{ImageReference, NamedReference, normalize};
use super::network_retry::{ATTEMPTS, backoff, transient};
use super::registry_credentials::{self, Credential};
use crate::CandidateError;
use crate::error::NetworkFailureReason;
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
    path::{Path, PathBuf},
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

thread_local! {
    static REQUESTS: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

/// One command's actual HTTP send attempts, including auth, redirects and
/// retries. The scope restores any outer count even if dispatch unwinds.
pub(super) fn count_requests<T>(operation: impl FnOnce() -> T) -> (T, u64) {
    struct Restore(Option<u64>);
    impl Drop for Restore {
        fn drop(&mut self) {
            REQUESTS.with(|count| count.set(self.0));
        }
    }
    let previous = REQUESTS.with(|count| count.replace(Some(0)));
    let restore = Restore(previous);
    let result = operation();
    let requests = REQUESTS.with(|count| count.get().unwrap_or_default());
    drop(restore);
    (result, requests)
}

#[cfg(test)]
pub(super) fn permits_recorded_fallback(failure: &CandidateError) -> bool {
    matches!(
        failure.cause_code.as_deref(),
        Some("registry_unreachable" | "registry_http_429")
    )
}

fn error(message: impl Into<crate::ErrorMessage>) -> CandidateError {
    CandidateError::new("registry_image", message)
}
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", crate::Hex(Sha256::digest(bytes)))
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

/// Whether `ip` is a globally reachable IPv4 unicast address. This is an allowlist in
/// spirit: every IANA special-purpose block is refused, including blocks with globally
/// reachable members (such as `192.0.0.9`), so classification fails closed.
fn public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0 // 0.0.0.0/8 "this network"
        || a == 10 // 10.0.0.0/8 private
        || (a == 100 && (64..128).contains(&b)) // 100.64.0.0/10 shared (CGNAT)
        || a == 127 // 127.0.0.0/8 loopback
        || (a == 169 && b == 254) // 169.254.0.0/16 link-local
        || (a == 172 && (16..32).contains(&b)) // 172.16.0.0/12 private
        || (a == 192 && b == 0 && c == 0) // 192.0.0.0/24 IETF protocol assignments
        || (a == 192 && b == 0 && c == 2) // 192.0.2.0/24 documentation
        || (a == 192 && b == 88 && c == 99) // 192.88.99.0/24 deprecated 6to4 relay
        || (a == 192 && b == 168) // 192.168.0.0/16 private
        || (a == 198 && (18..20).contains(&b)) // 198.18.0.0/15 benchmarking
        || (a == 198 && b == 51 && c == 100) // 198.51.100.0/24 documentation
        || (a == 203 && b == 0 && c == 113) // 203.0.113.0/24 documentation
        || a >= 224) // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, broadcast
}

/// Whether `ip` is a globally reachable unicast address. IPv6 must be in global unicast
/// `2000::/3`, outside IETF protocol assignments `2001::/23` (Teredo, benchmarking,
/// ORCHID and others, all refused), documentation `2001:db8::/32` and `3fff::/20`.
/// Forms that embed an IPv4 address (mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96`,
/// 6to4 `2002::/16`) are public only when the embedded address is. Everything else is
/// refused, including `::`, `::1`, IPv4-compatible `::/96`, discard `100::/64`, local-use
/// NAT64 `64:ff9b:1::/48`, ULA `fc00::/7`, link-local `fe80::/10` and multicast `ff00::/8`.
pub(super) fn public_ip(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V4(ip) => return public_ipv4(ip),
        IpAddr::V6(ip) => ip,
    };
    let s = ip.segments();
    let embedded = |high: u16, low: u16| {
        let [a, b] = high.to_be_bytes();
        let [c, d] = low.to_be_bytes();
        public_ipv4(Ipv4Addr::new(a, b, c, d))
    };
    if let Some(v4) = ip.to_ipv4_mapped() {
        return public_ipv4(v4);
    }
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return embedded(s[6], s[7]);
    }
    if s[0] == 0x2002 {
        return embedded(s[1], s[2]);
    }
    (s[0] & 0xe000) == 0x2000
        && !(s[0] == 0x2001 && s[1] < 0x0200)
        && !(s[0] == 0x2001 && s[1] == 0x0db8)
        && !(s[0] == 0x3fff && s[1] < 0x1000)
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

/// A lookup could not obtain addresses for a registry host.
#[derive(Debug)]
struct RegistryDnsUnavailable;

impl std::fmt::Display for RegistryDnsUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("registry host lookup failed")
    }
}

impl std::error::Error for RegistryDnsUnavailable {}

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
            let addresses = tokio::task::spawn_blocking(move || lookup(&host))
                .await?
                .map_err(|_| RegistryDnsUnavailable)?;
            if addresses.is_empty() {
                return Err(Box::new(RegistryDnsUnavailable) as _);
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
fn transport_error(failure: &reqwest::Error, message: &'static str) -> CandidateError {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(failure);
    while let Some(cause) = source {
        if cause.is::<LocalAddressRefused>() {
            return local_address_refused();
        }
        source = cause.source();
    }
    error(message)
}

/// Failure to establish a route to the registry is distinct from authentication,
/// TLS verification and an authoritative rejection by the registry.
fn tls_failure(failure: &reqwest::Error) -> Option<(&'static str, &'static str)> {
    let mut source = std::error::Error::source(failure);
    while let Some(error) = source {
        let text = error.to_string().to_ascii_lowercase();
        if text.contains("certificate") {
            return Some((
                "registry_certificate",
                "Registry certificate was not trusted.",
            ));
        }
        if text.contains("alert") {
            return Some(("registry_tls_handshake", "Registry TLS handshake failed."));
        }
        source = error.source();
    }
    None
}

fn registry_unreachable(failure: &reqwest::Error) -> bool {
    if !failure.is_connect() {
        return false;
    }
    let mut source = std::error::Error::source(failure);
    while let Some(cause) = source {
        if cause.is::<RegistryDnsUnavailable>() {
            return true;
        }
        if let Some(io) = cause.downcast_ref::<std::io::Error>()
            && matches!(
                io.kind(),
                std::io::ErrorKind::ConnectionRefused
                    | std::io::ErrorKind::NetworkUnreachable
                    | std::io::ErrorKind::HostUnreachable
                    | std::io::ErrorKind::NotConnected
                    | std::io::ErrorKind::TimedOut
            )
        {
            return true;
        }
        source = cause.source();
    }
    failure.is_timeout()
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
/// Refuse an object whose member for any of `fields` is not spelled exactly, or is
/// named more than once. The engine's Go decoder also accepts case variants and keeps
/// the last of repeated keys, while the exact-name parse below would miss or reject
/// them; refusing keeps both reading the same member.
fn canonical_members(value: &GoJson, fields: &[&str]) -> Result<(), CandidateError> {
    let GoJson::Object(members) = value else {
        return Ok(());
    };
    if super::go_json::ascii_keys(value).is_err() {
        return Err(error("Registry manifest member names must be ASCII."));
    }
    for field in fields {
        let mut matching = members
            .iter()
            .filter(|(key, _)| super::go_json::names_field(key, field));
        let first = matching.next();
        if matching.next().is_some() || first.is_some_and(|(key, _)| key != field) {
            return Err(error(
                "Registry manifest member names are repeated or not in their exact case.",
            ));
        }
    }
    Ok(())
}

fn canonical_descriptor(value: &GoJson) -> Result<(), CandidateError> {
    canonical_members(value, &["digest", "size", "mediaType", "platform", "urls"])?;
    if let Ok(Some(platform)) = value.field("platform") {
        canonical_members(platform, &["os", "architecture", "variant"])?;
    }
    Ok(())
}

/// The manifest or index members this module reads, checked for exact spelling.
fn canonical_manifest(bytes: &[u8]) -> Result<(), CandidateError> {
    let document = GoJson::parse(bytes).map_err(|_| error("Invalid registry manifest."))?;
    canonical_members(
        &document,
        &[
            "schemaVersion",
            "mediaType",
            "manifests",
            "config",
            "layers",
        ],
    )?;
    for list in ["manifests", "layers"] {
        if let Ok(Some(GoJson::Array(descriptors))) = document.field(list) {
            for descriptor in descriptors {
                canonical_descriptor(descriptor)?;
            }
        }
    }
    if let Ok(Some(config)) = document.field("config") {
        canonical_descriptor(config)?;
    }
    Ok(())
}

fn parse_manifest(bytes: &[u8], expected: &str) -> Result<Manifest, CandidateError> {
    if bytes.len() > MAX_METADATA || digest(bytes) != expected {
        return Err(error("Registry manifest digest or size mismatch.")
            .with_cause_code("registry_digest_mismatch".into()));
    }
    canonical_manifest(bytes)?;
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
/// The index entry for the first platform of `policy` that the index publishes exactly once.
/// A platform listed twice is ambiguous and refuses rather than falling through to the next.
/// The selected entry must be an image manifest.
fn select_platform(
    m: &Manifest,
    policy: PlatformPolicy,
) -> Result<(&Descriptor, ImagePlatform), CandidateError> {
    for platform in policy.candidates() {
        let mut selected = m.manifests.iter().filter(|d| {
            d.platform
                .as_ref()
                .is_some_and(|p| platform.matches(&p.os, &p.architecture, p.variant.as_deref()))
        });
        let Some(first) = selected.next() else {
            continue;
        };
        if selected.next().is_some() {
            return Err(match platform {
                ImagePlatform::LinuxArm64 => {
                    error("Pinned index has ambiguous Linux ARM64 images.")
                }
                ImagePlatform::LinuxAmd64 => {
                    error("Pinned index has ambiguous Linux AMD64 images.")
                }
            });
        }
        if !first.media_type.is_empty() && !MANIFEST_TYPES.contains(&first.media_type.as_str()) {
            return Err(match platform {
                ImagePlatform::LinuxArm64 => {
                    error("The Linux ARM64 index entry is not an image manifest.")
                }
                ImagePlatform::LinuxAmd64 => {
                    error("The Linux AMD64 index entry is not an image manifest.")
                }
            });
        }
        return Ok((first, *platform));
    }
    Err(unavailable(policy))
}
fn unavailable(policy: PlatformPolicy) -> CandidateError {
    match policy {
        PlatformPolicy::Native => error("Pinned index has no Linux ARM64 image."),
        PlatformPolicy::PreferNative => error("Pinned index has no Linux ARM64 or AMD64 image."),
        PlatformPolicy::Amd64 => error("Pinned index has no Linux AMD64 image."),
    }
}
fn bounded(mut reader: impl Read, limit: usize) -> Result<Vec<u8>, CandidateError> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|failure| {
            let cause = match read_failure(&failure) {
                NetworkFailureReason::Timeout => "registry_body_stalled",
                _ => "registry_transfer_failed",
            };
            error("Registry transfer failed or timed out.").with_cause_code(cause.into())
        })?;
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
    request_timeout: Duration,
    next_idle_check: Instant,
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
        let wait = policy.image_wait(ACQUISITION_DEADLINE)?;
        let wait = if policy.short_tag_refresh {
            wait.min(Duration::from_secs(3))
        } else {
            wait
        };
        Ok(Self {
            client,
            registry: registry.clone(),
            path: path.to_owned(),
            policy,
            authorization: None,
            stage: Stage::Anonymous,
            deadline: Instant::now() + wait,
            request_timeout: REQUEST_TIMEOUT,
            next_idle_check: Instant::now(),
        })
    }

    fn check_retention_idle(&mut self) -> Result<(), CandidateError> {
        if let Some(root) = &self.policy.retention_root
            && Instant::now() >= self.next_idle_check
        {
            super::image_build::check_retention_idle(root)?;
            self.next_idle_check = Instant::now() + Duration::from_millis(250);
        }
        Ok(())
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

    /// Replay GET headers only; never replay a body read or OAuth refresh POST.
    fn send_headers(
        &self,
        request: reqwest::blocking::RequestBuilder,
        url: &Url,
        timeout: Duration,
        retry: bool,
    ) -> Result<Response, CandidateError> {
        let attempts = if self.policy.short_tag_refresh
            || self.policy.tag_mode == super::image_policy::ImageTagMode::Refresh
        {
            1
        } else {
            ATTEMPTS
        };
        for attempt in 1..=attempts {
            let remaining =
                match self.remaining() {
                    Ok(remaining) => remaining,
                    Err(failure) => return Err(CandidateError::new(
                        failure.code,
                        format!(
                            "Registry acquisition deadline exceeded. Host {} after {} attempt(s).",
                            url.host_str().unwrap_or("unknown"),
                            attempt - 1
                        ),
                    )
                    .with_network_request(url.host_str().unwrap_or("unknown"), attempt - 1)),
                };
            let request = request
                .try_clone()
                .ok_or_else(|| error("Cannot replay registry request."))?;
            REQUESTS.with(|count| {
                if let Some(requests) = count.get() {
                    count.set(Some(requests.saturating_add(1)));
                }
            });
            match request.timeout(remaining.min(timeout)).send() {
                Ok(response) => return Ok(response),
                Err(failure) => {
                    let classified = transport_error(&failure, "Registry request failed.");
                    let delay = backoff(attempt);
                    if !retry
                        || !transient(&failure)
                        || classified.code != "registry_image"
                        || attempt == attempts
                        || self.remaining().unwrap_or_default() <= delay
                    {
                        if let Some((cause, message)) = tls_failure(&failure) {
                            return Err(CandidateError::new("registry_image", message)
                                .with_network_request(url.host_str().unwrap_or("unknown"), attempt)
                                .with_cause_code(cause.into()));
                        }
                        let error = CandidateError::new(
                            classified.code,
                            format!(
                                "{} Host {} after {attempt} attempt(s).",
                                classified.message,
                                url.host_str().unwrap_or("unknown"),
                            ),
                        )
                        .with_network_request(url.host_str().unwrap_or("unknown"), attempt);
                        return Err(if failure.is_timeout() {
                            error.with_cause_code("registry_headers_stalled".into())
                        } else if classified.code == "registry_image"
                            && registry_unreachable(&failure)
                        {
                            error.with_cause_code("registry_unreachable".into())
                        } else {
                            error
                        });
                    }
                    std::thread::sleep(delay);
                }
            }
        }
        unreachable!("bounded attempts return")
    }

    /// One request with redirects followed under [`redirect_allowed`]. Authorization is
    /// attached only while the request targets the registry origin.
    fn send(
        &self,
        mut url: Url,
        timeout: Duration,
        retry: bool,
    ) -> Result<Response, CandidateError> {
        for hop in 0..=4 {
            if !self.destination_allowed(&url) {
                return Err(local_address_refused());
            }
            let mut request = self.client.get(url.clone()).header(ACCEPT, ACCEPT_MANIFEST);
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
            // Every request here is an idempotent GET of a manifest or a
            // content-addressed blob, so a transient transport failure is retried
            // with the same bounded attempts and reports its host. A layer keeps its
            // size-scaled timeout; manifests and configs use the request timeout.
            let attempt_timeout = if retry { self.request_timeout } else { timeout };
            let response = self.send_headers(request, &url, attempt_timeout, true)?;
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
    fn get(
        &mut self,
        url: Url,
        timeout: Duration,
        retry: bool,
    ) -> Result<Response, CandidateError> {
        let response = self.answered(url, timeout, retry)?;
        refusal(response)
    }

    /// The response for `url` after the authentication challenges [`Self::get`]
    /// answers, whatever its final status; [`refusal`] maps a non-success status.
    fn answered(
        &mut self,
        url: Url,
        timeout: Duration,
        retry: bool,
    ) -> Result<Response, CandidateError> {
        self.check_retention_idle()?;
        loop {
            let response = self.send(url.clone(), timeout, retry)?;
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
                    .ok_or_else(|| {
                        error("Registry requires authentication without a challenge.")
                            .with_cause_code("registry_http_401".into())
                    })
                    .and_then(parse_challenge)?;
                self.authorize(&challenge)?;
                continue;
            }
            return Ok(response);
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
        let replayable = !matches!(credential, Some(Credential::IdentityToken(_)));
        let response = self.send_headers(
            request,
            realm,
            if replayable {
                self.request_timeout
            } else {
                REQUEST_TIMEOUT
            },
            replayable,
        )?;
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
            )
            .with_cause_code(format!("registry_http_{}", response.status().as_u16())));
        }
        if !response.status().is_success() {
            return Err(error("The registry token endpoint refused the request.")
                .with_cause_code(format!("registry_http_{}", response.status().as_u16())));
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
        let response = self.get(url, REQUEST_TIMEOUT, true)?;
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
        let response = self.get(
            self.url(kind, &d.digest)?,
            REQUEST_TIMEOUT,
            kind == "manifests",
        )?;
        let bytes = bounded(response, d.size as usize)?;
        verify_object(d, &bytes)?;
        Ok(bytes)
    }

    /// One layer blob downloaded into a private temporary file in `directory` and
    /// checked against its descriptor's exact size and digest before the caller adds it
    /// to the archive.
    ///
    /// A layer body can fail after its response headers, while it streams: a timeout,
    /// a connection that ends early, or bytes that do not match. Each such attempt is
    /// retried up to [`ATTEMPTS`] times, because the blob is content-addressed and the
    /// request an idempotent GET. A build uses its remaining acquisition budget.
    /// Other callers use the size-scaled timeout, cut to the acquisition deadline, never
    /// extended; an attempt that would start after it, or a backoff that would outlast
    /// it, stops with [`NetworkFailureReason::Deadline`]. A failure names the host that
    /// served the body (after redirects), the attempts made and the last reason. Each
    /// attempt's temporary file is removed when the attempt fails; the returned file is
    /// removed when it is dropped.
    fn layer(&mut self, d: &Descriptor, directory: &Path) -> Result<LayerFile, CandidateError> {
        let url = self.url("blobs", &d.digest)?;
        let timeout = self.policy.image_wait(
            self.request_timeout + Duration::from_secs(d.size / MIN_BLOB_BYTES_PER_SECOND),
        )?;
        let mut host = url.host_str().unwrap_or("unknown").to_owned();
        for attempt in 1..=ATTEMPTS {
            if self.remaining().is_err() {
                return Err(layer_failure(
                    &host,
                    attempt - 1,
                    NetworkFailureReason::Deadline,
                    None,
                ));
            }
            let failed = match self.layer_attempt(&url, d, timeout, (&mut host, attempt), directory)
            {
                Ok(file) => return Ok(file),
                Err(LayerAttempt::Refused(failure)) => return Err(failure),
                Err(LayerAttempt::Failed(reason, status)) => (reason, status),
            };
            let (reason, status) = failed;
            if attempt == ATTEMPTS {
                return Err(layer_failure(&host, attempt, reason, status));
            }
            let delay = backoff(attempt);
            if self.remaining().unwrap_or_default() <= delay {
                // The deadline, not this attempt's failure, is what prevents another
                // attempt: an attempt it cut short, or a backoff that would outlast it.
                return Err(layer_failure(
                    &host,
                    attempt,
                    NetworkFailureReason::Deadline,
                    None,
                ));
            }
            std::thread::sleep(delay);
        }
        unreachable!("bounded attempts return")
    }

    /// One download attempt for [`Self::layer`]. Failures before response headers keep
    /// the bounded replay in [`Self::send_headers`] and end the layer, as before.
    fn layer_attempt(
        &mut self,
        url: &Url,
        d: &Descriptor,
        timeout: Duration,
        (host, attempt): (&mut String, usize),
        directory: &Path,
    ) -> Result<LayerFile, LayerAttempt> {
        let mut response = self
            .answered(url.clone(), timeout, false)
            .map_err(LayerAttempt::Refused)?;
        if let Some(served) = response.url().host_str() {
            served.clone_into(host);
        }
        let status = response.status();
        if !status.is_success() {
            if retryable_status(status) {
                return Err(LayerAttempt::Failed(
                    NetworkFailureReason::HttpStatus,
                    Some(status.as_u16()),
                ));
            }
            // Access and absence keep their own guidance; any other status is named
            // with the host, attempts and code like a retried one.
            return Err(LayerAttempt::Refused(
                if matches!(
                    status,
                    StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
                ) {
                    match refusal(response) {
                        Err(failure) => failure,
                        Ok(_) => unreachable!("a non-success status refuses"),
                    }
                } else {
                    layer_failure(
                        host,
                        attempt,
                        NetworkFailureReason::HttpStatus,
                        Some(status.as_u16()),
                    )
                },
            ));
        }
        if response.content_length().is_some_and(|n| n != d.size) {
            return Err(LayerAttempt::Failed(
                NetworkFailureReason::SizeMismatch,
                None,
            ));
        }
        let mut file = LayerFile::create(directory).map_err(LayerAttempt::Refused)?;
        let mut digest = Sha256::new();
        let mut total = 0_u64;
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            self.check_retention_idle().map_err(LayerAttempt::Refused)?;
            let n = match response.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => n,
                Err(failure) if failure.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(failure) => return Err(LayerAttempt::Failed(read_failure(&failure), None)),
            };
            total += n as u64;
            if total > d.size {
                return Err(LayerAttempt::Failed(
                    NetworkFailureReason::SizeMismatch,
                    None,
                ));
            }
            digest.update(&buffer[..n]);
            file.file.write_all(&buffer[..n]).map_err(|_| {
                LayerAttempt::Refused(error(
                    "Cannot write a registry layer to its temporary file.",
                ))
            })?;
        }
        if total < d.size {
            return Err(LayerAttempt::Failed(NetworkFailureReason::ShortRead, None));
        }
        if format!("sha256:{:x}", crate::Hex(digest.finalize())) != d.digest {
            return Err(LayerAttempt::Failed(
                NetworkFailureReason::DigestMismatch,
                None,
            ));
        }
        file.rewind().map_err(LayerAttempt::Refused)?;
        Ok(file)
    }
}

/// How one layer download attempt ended without a verified file.
enum LayerAttempt {
    /// A refusal that another attempt cannot change (access, a missing blob, a
    /// pre-header transport failure already replayed, or a local file error).
    Refused(CandidateError),
    /// A failure another attempt may not repeat, with the HTTP status when it is one.
    Failed(NetworkFailureReason, Option<u16>),
}

/// A status another attempt may not repeat: a request timeout, rate limiting or a
/// server-side failure.
fn retryable_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::REQUEST_TIMEOUT
            | StatusCode::TOO_MANY_REQUESTS
            | StatusCode::INTERNAL_SERVER_ERROR
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    )
}

/// A body read error: the attempt's time limit, or a connection that ended early.
fn read_failure(failure: &std::io::Error) -> NetworkFailureReason {
    let timed_out = failure.kind() == std::io::ErrorKind::TimedOut
        || failure
            .get_ref()
            .and_then(|inner| inner.downcast_ref::<reqwest::Error>())
            .is_some_and(reqwest::Error::is_timeout);
    if timed_out {
        NetworkFailureReason::Timeout
    } else {
        NetworkFailureReason::ShortRead
    }
}

/// The closed sentence for a failed layer download, naming its host and attempts.
fn layer_failure(
    host: &str,
    attempts: usize,
    reason: NetworkFailureReason,
    status: Option<u16>,
) -> CandidateError {
    let why = match (reason, status) {
        (NetworkFailureReason::Timeout, _) => "the transfer timed out".to_owned(),
        (NetworkFailureReason::ShortRead, _) => {
            "the connection ended before the whole layer arrived".to_owned()
        }
        (NetworkFailureReason::DigestMismatch, _) => {
            "the layer did not match its digest".to_owned()
        }
        (NetworkFailureReason::SizeMismatch, _) => "the layer did not match its size".to_owned(),
        (NetworkFailureReason::HttpStatus, Some(code)) => {
            format!("the registry answered HTTP {code}")
        }
        (NetworkFailureReason::HttpStatus, None) => {
            "the registry answered an error status".to_owned()
        }
        (NetworkFailureReason::Deadline, _) => {
            "the image acquisition deadline was reached".to_owned()
        }
    };
    let failure = error(format!(
        "A registry layer transfer failed: {why}. Host {host} after {attempts} attempt(s)."
    ))
    .with_network_failure(host, attempts, reason, status);
    match (reason, status) {
        (NetworkFailureReason::DigestMismatch, _) => {
            failure.with_cause_code("registry_digest_mismatch".into())
        }
        (NetworkFailureReason::Timeout | NetworkFailureReason::Deadline, _) => {
            failure.with_cause_code("registry_body_stalled".into())
        }
        (NetworkFailureReason::HttpStatus, Some(code)) => {
            failure.with_cause_code(format!("registry_http_{code}"))
        }
        _ => failure,
    }
}

/// One layer's private temporary file next to the archive being assembled. Created
/// exclusively (never through a link); dropping it removes exactly this path.
struct LayerFile {
    path: PathBuf,
    file: File,
}

impl LayerFile {
    fn create(directory: &Path) -> Result<Self, CandidateError> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = directory.join(format!(
            ".hack-layer-{}-{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .map_err(|_| error("Cannot exclusively create a temporary registry layer file."))?;
        Ok(Self { path, file })
    }

    fn rewind(&mut self) -> Result<(), CandidateError> {
        use std::io::Seek as _;
        self.file
            .flush()
            .and_then(|()| self.file.rewind())
            .map_err(|_| error("Cannot read back a temporary registry layer file."))
    }
}

impl Drop for LayerFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// A successful response, or the refusal its status means.
fn refusal(response: Response) -> Result<Response, CandidateError> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let failure = match status {
        StatusCode::NOT_FOUND => CandidateError::new(
            "registry_image_not_found",
            "The registry image or requested tag was not found.",
        ),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            error("The registry refused access with the Docker credentials configured for it.")
        }
        StatusCode::TOO_MANY_REQUESTS => {
            error("The registry rate-limited this request; retry later or configure credentials.")
        }
        _ => error("The registry request was refused."),
    };
    Err(failure.with_cause_code(format!("registry_http_{}", status.as_u16())))
}

fn verify_object(descriptor: &Descriptor, bytes: &[u8]) -> Result<(), CandidateError> {
    if bytes.len() as u64 != descriptor.size || digest(bytes) != descriptor.digest {
        return Err(error("Registry object digest or size mismatch.")
            .with_cause_code("registry_digest_mismatch".into()));
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
            let actual = format!(
                "sha256:{:x}",
                crate::Hex(std::mem::take(&mut self.digest).finalize())
            );
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
    #[serde(skip)]
    pub(super) proof: Option<ManifestProof>,
    pub source_digest: String,
    pub manifest_digest: String,
    pub image_id: String,
    pub archive_sha256: String,
    pub archive_bytes: u64,
    /// The platform selected by policy and confirmed by the image configuration.
    pub platform: ImagePlatform,
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
    #[serde(skip)]
    pub(super) proof: ManifestProof,
    pub pinned_reference: String,
    pub source_digest: String,
    pub manifest_digest: String,
    pub image_id: String,
    pub platform: &'static str,
}

/// The original bytes that bind a registry digest to one selected config.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ManifestProof {
    initial: String,
    child: Option<String>,
    config: String,
}

/// JSON escaping can expand any one of the three bounded metadata objects.
pub(super) const MANIFEST_PROOF_LIMIT: u64 = (3 * MAX_METADATA * 6 + 1024) as u64;

impl ManifestProof {
    fn new(
        initial: Vec<u8>,
        child: Option<Vec<u8>>,
        config: Vec<u8>,
    ) -> Result<Self, CandidateError> {
        fn utf8(bytes: Vec<u8>) -> Result<String, CandidateError> {
            String::from_utf8(bytes).map_err(|_| error("Registry image metadata is not UTF-8."))
        }
        Ok(Self {
            initial: utf8(initial)?,
            child: child.map(utf8).transpose()?,
            config: utf8(config)?,
        })
    }

    pub(super) fn verified_config(
        &self,
        pin: &str,
        policy: PlatformPolicy,
    ) -> Result<(ImagePlatform, String), CandidateError> {
        let (manifest, selected) = self.verified_manifest(pin, policy)?;
        Ok((selected, manifest.config.expect("checked manifest").digest))
    }

    pub(super) fn verified_build_base(
        &self,
        pin: &str,
        archive_limit: u64,
    ) -> Result<BuildBase, CandidateError> {
        let (_, source_digest) = pinned_syntax(pin)?;
        let (manifest, _) = self.verified_manifest(pin, PlatformPolicy::Native)?;
        bounded_build_base(&manifest, pin, archive_limit)?;
        if declares_onbuild(self.config.as_bytes())? {
            return Err(CandidateError::new(
                "native_build_base_image",
                "A build base image declares ONBUILD triggers; native builds refuse stored triggers.",
            ));
        }
        Ok(BuildBase {
            pinned_reference: pin.into(),
            source_digest,
            image_id: manifest.config.expect("checked manifest").digest,
        })
    }

    fn verified_manifest(
        &self,
        pin: &str,
        policy: PlatformPolicy,
    ) -> Result<(Manifest, ImagePlatform), CandidateError> {
        let (_, expected) = pinned_syntax(pin)?;
        let initial = parse_manifest(self.initial.as_bytes(), &expected)?;
        let (manifest, indexed) = if initial.manifests.is_empty() {
            if self.child.is_some() {
                return Err(error(
                    "Stored image proof has an unexpected child manifest.",
                ));
            }
            (initial, None)
        } else {
            let (descriptor, selected) = select_platform(&initial, policy)?;
            Fetch::checked(descriptor, MAX_METADATA as u64)?;
            let child = self
                .child
                .as_ref()
                .ok_or_else(|| error("Stored image proof lacks the selected child manifest."))?;
            verify_object(descriptor, child.as_bytes())?;
            (
                parse_manifest(child.as_bytes(), &descriptor.digest)?,
                Some(selected),
            )
        };
        check_selected_manifest(&manifest)?;
        let config = manifest
            .config
            .as_ref()
            .ok_or_else(|| error("Image config descriptor is missing."))?;
        Fetch::checked(config, MAX_METADATA as u64)?;
        verify_object(config, self.config.as_bytes())?;
        let selected = config_platform(self.config.as_bytes(), policy, indexed)?;
        Ok((manifest, selected))
    }
}

#[cfg(test)]
pub(super) fn test_manifest_resolution() -> ResolvedImage {
    let config = br#"{"architecture":"arm64","os":"linux"}"#;
    let image_id = digest(config);
    let manifest = serde_json::json!({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {
            "mediaType": "application/vnd.oci.image.config.v1+json",
            "digest": image_id,
            "size": config.len(),
        },
        "layers": [{
            "mediaType": "application/vnd.oci.image.layer.v1.tar",
            "digest": format!("sha256:{}", "d".repeat(64)),
            "size": 1,
        }],
    })
    .to_string()
    .into_bytes();
    let source = digest(&manifest);
    ResolvedImage {
        source_digest: source.clone(),
        manifest_digest: source.clone(),
        pinned_reference: format!("docker.io/fixture/image@{source}"),
        platform: "linux/arm64",
        image_id,
        proof: ManifestProof::new(manifest, None, config.to_vec()).unwrap(),
    }
}

type SelectedManifest = (Manifest, String, Option<ImagePlatform>, Option<Vec<u8>>);

/// The selected single-image manifest, its digest and, for an index, the platform the
/// index selection chose under `platform`.
fn select(
    fetch: &mut Fetch<'_>,
    initial: &[u8],
    source_digest: &str,
    platform: PlatformPolicy,
) -> Result<SelectedManifest, CandidateError> {
    let mut manifest = parse_manifest(initial, source_digest)?;
    let mut manifest_digest = source_digest.to_owned();
    let mut indexed = None;
    let mut child = None;
    if !manifest.manifests.is_empty() {
        let (selected, selected_platform) = select_platform(&manifest, platform)?;
        let selected = selected.clone();
        indexed = Some(selected_platform);
        manifest_digest = selected.digest.clone();
        let bytes = fetch.object("manifests", &selected)?;
        manifest = parse_manifest(&bytes, &manifest_digest)?;
        child = Some(bytes);
    }
    check_selected_manifest(&manifest)?;
    Ok((manifest, manifest_digest, indexed, child))
}

fn check_selected_manifest(manifest: &Manifest) -> Result<(), CandidateError> {
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
    Ok(())
}

/// Resolve mutable metadata once and return an explicit immutable identity. No image
/// layers, archive or runtime state are accessed; credentials are read only if the
/// registry challenges. A later fetch must use `pinned_reference`.
pub fn resolve(
    reference_text: &str,
    policy: &ImagePolicy,
) -> Result<ResolvedImage, CandidateError> {
    resolve_with(reference_text, policy, PlatformPolicy::Native)
}

/// [`resolve`] under an explicit platform policy. Only an opted-in policy can select
/// `linux/amd64`; the selected platform is part of the returned identity.
pub fn resolve_with(
    reference_text: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
) -> Result<ResolvedImage, CandidateError> {
    let (registry, path, tag) = tagged(reference_text, policy)?;
    let mut fetch = Fetch::new(&registry, &path, policy)?;
    let initial = fetch.manifest(&tag)?;
    let source_digest = digest(&initial);
    resolve_metadata(
        &mut fetch,
        &registry,
        &path,
        initial,
        source_digest,
        platform,
    )
}

pub(super) fn resolve_pinned(
    reference_text: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
) -> Result<ResolvedImage, CandidateError> {
    let pin = pinned(reference_text, policy)?;
    let mut fetch = Fetch::new(&pin.registry, &pin.path, policy)?;
    let initial = fetch.manifest(&pin.digest)?;
    resolve_metadata(
        &mut fetch,
        &pin.registry,
        &pin.path,
        initial,
        pin.digest,
        platform,
    )
}

fn resolve_metadata(
    fetch: &mut Fetch<'_>,
    registry: &Registry,
    path: &str,
    initial: Vec<u8>,
    source_digest: String,
    platform: PlatformPolicy,
) -> Result<ResolvedImage, CandidateError> {
    let (manifest, manifest_digest, indexed, child) =
        select(fetch, &initial, &source_digest, platform)?;
    let config = manifest
        .config
        .ok_or_else(|| error("Image config descriptor is missing."))?;
    let config_bytes = fetch.object("blobs", &config)?;
    let selected = config_platform(&config_bytes, platform, indexed)?;
    Ok(ResolvedImage {
        proof: ManifestProof::new(initial, child, config_bytes)?,
        pinned_reference: format!("{}/{path}@{source_digest}", registry.domain),
        source_digest,
        manifest_digest,
        image_id: config.digest,
        platform: selected.name(),
    })
}

/// The platform the actual image configuration targets. An index selection must be
/// confirmed by the configuration; a single manifest is admitted only for a platform the
/// policy allows.
fn config_platform(
    config_bytes: &[u8],
    policy: PlatformPolicy,
    indexed: Option<ImagePlatform>,
) -> Result<ImagePlatform, CandidateError> {
    let config = platform_fields(config_bytes)?;
    let allowed: &[ImagePlatform] = match &indexed {
        Some(platform) => std::slice::from_ref(platform),
        None => policy.candidates(),
    };
    allowed
        .iter()
        .copied()
        .find(|platform| platform.matches_config(&config))
        .ok_or_else(|| match policy {
            PlatformPolicy::Native => {
                error("Image configuration does not target supported Linux ARM64.")
            }
            _ => error("Image configuration does not target the selected Linux platform."),
        })
}

/// The platform `platform` selects for one pinned reference: the index entry it prefers,
/// or a single-image manifest's configured platform. Only bounded metadata is fetched,
/// through the same guarded, origin-bound client as acquisition; no layer or archive is
/// read, and acquisition still confirms the selection against the configuration.
pub(super) fn pinned_platform(
    reference_text: &str,
    policy: &ImagePolicy,
    platform: PlatformPolicy,
) -> Result<ImagePlatform, CandidateError> {
    let pinned = pinned(reference_text, policy)?;
    let mut fetch = Fetch::new(&pinned.registry, &pinned.path, policy)?;
    let initial = fetch.manifest(&pinned.digest)?;
    let manifest = parse_manifest(&initial, &pinned.digest)?;
    if !manifest.manifests.is_empty() {
        return select_platform(&manifest, platform).map(|(_, selected)| selected);
    }
    let config = manifest
        .config
        .ok_or_else(|| error("Image config descriptor is missing."))?;
    let config_bytes = fetch.object("blobs", &config)?;
    config_platform(&config_bytes, platform, None)
}

/// A base image a native build may pull, pinned to the exact manifest the registry
/// served when the build was admitted.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BuildBase {
    /// `docker.io/<repository>@<source digest>`: the only form handed to the builder.
    pub pinned_reference: String,
    /// Digest of the manifest or index the reference resolved to.
    pub source_digest: String,
    /// Content ID of the selected Linux ARM64 image.
    pub image_id: String,
}

/// Refuse a build base whose manifest declares more than `limit` compressed bytes of
/// config and layers (the per-image archive budget acquisition applies), or no layers
/// or more than the layer limit. Every descriptor's `size` is a required unsigned
/// integer (the manifest parse refuses a missing, negative or fractional one), so the
/// declared total is exact; it does not bound the unpacked size.
fn bounded_build_base(
    manifest: &Manifest,
    reference: &str,
    limit: u64,
) -> Result<(), CandidateError> {
    if manifest.layers.is_empty() || manifest.layers.len() > MAX_LAYERS {
        return Err(CandidateError::new(
            "native_build_base_image",
            format!(
                "Build base image {reference} declares {} layers; native builds accept 1 to {MAX_LAYERS}. No build was run.",
                manifest.layers.len()
            ),
        ));
    }
    let config = manifest
        .config
        .as_ref()
        .ok_or_else(|| error("Image config descriptor is missing."))?;
    let refused = |what: &str, reason: CandidateError| {
        CandidateError::new(
            "native_build_base_image",
            format!(
                "Build base image {reference} has an unsupported {what}: {} No build was run.",
                reason.message
            ),
        )
    };
    if !config.media_type.is_empty() && !CONFIG_TYPES.contains(&config.media_type.as_str()) {
        return Err(refused(
            "config descriptor",
            error("The manifest does not describe a container image."),
        ));
    }
    Fetch::checked(config, MAX_METADATA as u64).map_err(|e| refused("config descriptor", e))?;
    for layer in &manifest.layers {
        layer_extension(&layer.media_type).map_err(|e| refused("layer", e))?;
        Fetch::checked(layer, super::image_policy::ARCHIVE_CEILING)
            .map_err(|e| refused("layer", e))?;
    }
    let declared = manifest
        .layers
        .iter()
        .try_fold(config.size, |total, layer| total.checked_add(layer.size));
    match declared {
        Some(total) if total <= limit => Ok(()),
        _ => Err(CandidateError::new(
            "native_build_base_image",
            format!(
                "Build base image {reference} declares {} bytes of config and layers, more than the {limit}-byte image budget. No build was run.",
                declared.map_or_else(|| "at least 2^64".to_owned(), |total| total.to_string())
            ),
        )),
    }
}

fn ambiguous(reason: super::go_json::Unreadable) -> CandidateError {
    match reason {
        super::go_json::Unreadable::Ambiguous => error(
            "Image configuration names one field more than once (keys differing only in case count as the same field).",
        ),
        super::go_json::Unreadable::NonAsciiKey => {
            error("Image configuration member names must be ASCII.")
        }
    }
}

/// The `os`, `architecture` and `variant` members of an image configuration as the
/// engine reads them (see [`super::go_json`]), as a document for
/// [`ImagePlatform::matches_config`]. A member named more than once refuses.
pub(super) fn platform_fields(config_bytes: &[u8]) -> Result<serde_json::Value, CandidateError> {
    let config = GoJson::parse(config_bytes).map_err(|_| error("Invalid image configuration."))?;
    if !matches!(config, GoJson::Object(_)) {
        return Err(error("Invalid image configuration."));
    }
    let mut fields = serde_json::Map::new();
    for name in ["os", "architecture", "variant"] {
        if let Some(value) = config.field(name).map_err(ambiguous)? {
            fields.insert(name.to_owned(), value.to_value());
        }
    }
    Ok(serde_json::Value::Object(fields))
}

/// Whether an image configuration carries stored `ONBUILD` triggers, read as the
/// engine and BuildKit read it: keys match case-insensitively (`onbuild`, `ONBUILD`), at
/// the top level and under `config` and the legacy `container_config`. A field named
/// more than once, or holding anything but an array or `null`, refuses.
fn declares_onbuild(config_bytes: &[u8]) -> Result<bool, CandidateError> {
    let document =
        GoJson::parse(config_bytes).map_err(|_| error("Invalid image configuration."))?;
    if !matches!(document, GoJson::Object(_)) {
        return Err(error("Invalid image configuration."));
    }
    let mut scopes = vec![&document];
    for name in ["config", "container_config"] {
        match document.field(name).map_err(ambiguous)? {
            None | Some(GoJson::Null) => {}
            Some(object @ GoJson::Object(_)) => scopes.push(object),
            Some(_) => return Err(error("Invalid image configuration.")),
        }
    }
    let mut declared = false;
    for scope in scopes {
        match scope.field("OnBuild").map_err(ambiguous)? {
            None | Some(GoJson::Null) => {}
            Some(GoJson::Array(triggers)) => declared |= !triggers.is_empty(),
            Some(_) => return Err(error("Invalid image configuration.")),
        }
    }
    Ok(declared)
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
    acquire_with(
        reference_text,
        output,
        policy,
        limit,
        PlatformPolicy::Native,
    )
}

/// [`acquire`] under an explicit platform policy; the archive is validated for the platform
/// that was selected and confirmed by the image configuration.
pub fn acquire_with(
    reference_text: &str,
    output: &Path,
    policy: &ImagePolicy,
    limit: u64,
    platform: PlatformPolicy,
) -> Result<AcquiredImage, CandidateError> {
    acquire_with_disk_admission(reference_text, output, policy, limit, platform, |_| Ok(()))
}

pub(super) fn acquire_with_disk_admission<T>(
    reference_text: &str,
    output: &Path,
    policy: &ImagePolicy,
    limit: u64,
    platform: PlatformPolicy,
    reserve: impl FnOnce(u64) -> Result<T, CandidateError>,
) -> Result<AcquiredImage, CandidateError> {
    let pinned = pinned(reference_text, policy)?;
    let limit = limit.min(policy.archive_limit);
    if output.exists() {
        return Err(error("Image archive output already exists."));
    }
    let mut fetch = Fetch::new(&pinned.registry, &pinned.path, policy)?;
    let initial = fetch.manifest(&pinned.digest)?;
    let (manifest, manifest_digest, indexed, child) =
        select(&mut fetch, &initial, &pinned.digest, platform)?;
    let config = manifest
        .config
        .clone()
        .ok_or_else(|| error("Image config descriptor is missing."))?;
    let config_bytes = fetch.object("blobs", &config)?;
    let selected = config_platform(&config_bytes, platform, indexed)?;
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
    // The current layer coexists with the growing archive until it is appended.
    let largest_layer = manifest
        .layers
        .iter()
        .map(|layer| layer.size)
        .max()
        .unwrap_or(0);
    let _disk = reserve(planned.saturating_add(largest_layer))?;
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
                // Each layer is downloaded and verified in full before it joins the
                // archive; its temporary file is removed when `downloaded` drops.
                let mut downloaded = fetch.layer(layer, output_directory(output))?;
                let mut verified = Verified {
                    inner: &mut downloaded.file,
                    digest: Sha256::new(),
                    total: 0,
                    size: layer.size,
                    expected: layer.digest.clone(),
                };
                builder
                    .append_data(&mut header(layer.size), name, &mut verified)
                    .map_err(|_| assemble())?;
            }
            builder
                .append_data(
                    &mut header(manifest_bytes.len() as u64),
                    "manifest.json",
                    manifest_bytes.as_slice(),
                )
                .map_err(|_| assemble())?;
            let writer = builder.into_inner().map_err(|_| assemble())?;
            Ok((
                format!("{:x}", crate::Hex(writer.digest.finalize())),
                writer.total,
            ))
        },
        |temporary, (sha, total)| {
            if Instant::now() >= deadline {
                return Err(error("Registry acquisition deadline exceeded."));
            }
            if image_load::validate_file_for(temporary, sha, &config.digest, policy, selected)?
                != *total
            {
                return Err(error(
                    "The assembled image archive changed before publication.",
                ));
            }
            Ok(())
        },
    )?;
    Ok(AcquiredImage {
        proof: Some(ManifestProof::new(initial, child, config_bytes)?),
        source_digest: pinned.digest,
        manifest_digest,
        image_id: config.digest,
        archive_sha256: written.0,
        archive_bytes: written.1,
        platform: selected,
    })
}

/// Write a new exclusive temporary file, sync and verify it, then link it into place
/// without replacing a competing output.
/// The directory that holds `output` and every temporary file of its acquisition.
fn output_directory(output: &Path) -> &Path {
    output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

fn publish<T>(
    output: &Path,
    write: impl FnOnce(&mut File) -> Result<T, CandidateError>,
    verify: impl FnOnce(&Path, &T) -> Result<(), CandidateError>,
) -> Result<T, CandidateError> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = output_directory(output);
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
