//! Registry acquisition tests against an in-process fake OCI distribution registry on
//! loopback. The fake registry is admitted only through an explicit `http://` local
//! registry opt-in; no test reaches a public registry, the user's Docker configuration,
//! a credential store or a runtime.
use super::*;
use crate::provider::image_load::tests::{Layer, compress};
use crate::provider::image_policy::LocalRegistry;
use crate::provider::registry_credentials::tests::DockerFixture;
use base64::Engine as _;
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader},
    net::{IpAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering as AtomicOrdering},
    },
    thread::JoinHandle,
};

const REPOSITORY: &str = "team/sub/app";
const USER: &str = "fixture-user";
const PASSWORD: &str = "fixture-password";

#[derive(Clone, Debug)]
struct Request {
    method: String,
    path: String,
    authorization: Option<String>,
    body: String,
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Reply {
    fn new(status: u16, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: body.into(),
        }
    }
    fn header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Auth {
    None,
    /// Bearer realm on the registry origin; anonymous tokens cannot pull.
    Bearer,
    /// Basic authentication on every registry request.
    Basic,
}

#[derive(Clone)]
struct Content {
    manifests: BTreeMap<String, (String, Vec<u8>)>,
    blobs: BTreeMap<String, Vec<u8>>,
    tag: String,
    index_digest: String,
    manifest_digest: String,
    config_digest: String,
    layer_digests: Vec<String>,
}

fn descriptor(media_type: &str, bytes: &[u8]) -> serde_json::Value {
    serde_json::json!({"mediaType": media_type, "digest": digest(bytes), "size": bytes.len()})
}

/// One multi-platform image: a zstd and a gzip layer for Linux ARM64, a decoy AMD64
/// manifest and an attestation-style entry, indexed under tag `v1`.
fn content() -> Content {
    let payloads: Vec<Vec<u8>> = vec![
        (0..40_000_u32).map(|n| (n % 241) as u8).collect(),
        (0..30_000_u32).map(|n| (n % 13) as u8).collect(),
    ];
    let layers = [
        (
            "application/vnd.oci.image.layer.v1.tar+zstd",
            compress(Layer::Zstd, &payloads[0]),
        ),
        (
            "application/vnd.docker.image.rootfs.diff.tar.gzip",
            compress(Layer::Gzip, &payloads[1]),
        ),
    ];
    let config = serde_json::to_vec(&serde_json::json!({
        "architecture": "arm64", "os": "linux",
        "rootfs": {"type": "layers", "diff_ids": payloads.iter().map(|p| digest(p)).collect::<Vec<_>>()}
    }))
    .unwrap();
    let manifest = serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": descriptor("application/vnd.oci.image.config.v1+json", &config),
        "layers": layers.iter().map(|(t, b)| descriptor(t, b)).collect::<Vec<_>>(),
    }))
    .unwrap();
    let decoy = serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": descriptor("application/vnd.oci.image.config.v1+json", b"{}"),
        "layers": [descriptor("application/vnd.oci.image.layer.v1.tar+gzip", b"decoy")],
    }))
    .unwrap();
    let entry = |bytes: &[u8], architecture: &str| {
        let mut value = descriptor("application/vnd.oci.image.manifest.v1+json", bytes);
        value["platform"] = serde_json::json!({"os": if architecture == "unknown" {"unknown"} else {"linux"}, "architecture": architecture});
        value
    };
    let index = serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [entry(&decoy, "amd64"), entry(&manifest, "arm64"), entry(&decoy, "unknown")],
    }))
    .unwrap();
    let mut content = Content {
        manifests: BTreeMap::new(),
        blobs: BTreeMap::new(),
        tag: "v1".into(),
        index_digest: digest(&index),
        manifest_digest: digest(&manifest),
        config_digest: digest(&config),
        layer_digests: layers.iter().map(|(_, b)| digest(b)).collect(),
    };
    for (media_type, bytes) in [
        ("application/vnd.oci.image.index.v1+json", index),
        ("application/vnd.oci.image.manifest.v1+json", manifest),
        ("application/vnd.oci.image.manifest.v1+json", decoy),
    ] {
        content
            .manifests
            .insert(digest(&bytes), (media_type.into(), bytes));
    }
    content.blobs.insert(digest(&config), config);
    for (_, bytes) in layers {
        content.blobs.insert(digest(&bytes), bytes);
    }
    content
}

struct Registry {
    port: u16,
    log: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

fn read_request(stream: &TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_owned();
    let path = parts.next()?.to_owned();
    let (mut authorization, mut length) = (None, 0_usize);
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':')?;
        match name.to_ascii_lowercase().as_str() {
            "authorization" => authorization = Some(value.trim().to_owned()),
            "content-length" => length = value.trim().parse().ok()?,
            _ => {}
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    Some(Request {
        method,
        path,
        authorization,
        body: String::from_utf8(body).ok()?,
    })
}

/// A fake server's reply to one request, given the server's own port.
type Handler = Box<dyn Fn(&Request, u16) -> Reply + Send>;

impl Registry {
    fn start(content: Content, auth: Auth, tamper: bool) -> Self {
        Self::serve(Box::new(move |request, port| {
            respond(&content, auth, tamper, port, request)
        }))
    }

    fn serve(handler: Handler) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (thread_log, thread_stop) = (log.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            for stream in listener.incoming() {
                if thread_stop.load(AtomicOrdering::SeqCst) {
                    return;
                }
                let Ok(mut stream) = stream else { continue };
                let Some(request) = read_request(&stream) else {
                    continue;
                };
                thread_log.lock().unwrap().push(request.clone());
                let reply = handler(&request, port);
                let mut head = format!(
                    "HTTP/1.1 {} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n",
                    reply.status,
                    reply.body.len()
                );
                for (name, value) in &reply.headers {
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                head.push_str("\r\n");
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&reply.body);
            }
        });
        Self {
            port,
            log,
            stop,
            thread: Some(thread),
        }
    }

    fn domain(&self) -> String {
        format!("127.0.0.1:{}", self.port)
    }

    fn origin(&self) -> String {
        format!("http://{}", self.domain())
    }

    fn policy(&self, docker: &DockerFixture) -> ImagePolicy {
        ImagePolicy {
            local_registries: vec![LocalRegistry {
                domain: self.domain(),
                plain_http: true,
            }],
            ..docker.policy()
        }
    }

    fn requests(&self) -> Vec<Request> {
        self.log.lock().unwrap().clone()
    }
}

impl Drop for Registry {
    fn drop(&mut self) {
        self.stop.store(true, AtomicOrdering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn basic_value() -> String {
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{USER}:{PASSWORD}"))
    )
}

fn respond(content: &Content, auth: Auth, tamper: bool, port: u16, request: &Request) -> Reply {
    let authorization = request.authorization.as_deref();
    if request.path.starts_with("/token") {
        // Anonymous tokens are issued but cannot pull; credentials earn a pull token.
        return match authorization {
            None => Reply::new(200, r#"{"token":"anonymous-token"}"#),
            Some(value) if value == basic_value() => {
                Reply::new(200, r#"{"access_token":"pull-token"}"#)
            }
            Some(_) => Reply::new(401, "{}"),
        };
    }
    let authorized = match auth {
        Auth::None => true,
        Auth::Bearer => authorization == Some("Bearer pull-token"),
        Auth::Basic => authorization == Some(basic_value().as_str()),
    };
    if !authorized && !request.path.starts_with("/storage/") {
        let challenge = match auth {
            Auth::Bearer => format!(
                r#"Bearer realm="http://127.0.0.1:{port}/token",service="fixture-registry",scope="repository:{REPOSITORY}:pull""#
            ),
            _ => r#"Basic realm="fixture""#.to_owned(),
        };
        return Reply::new(401, "{}").header("WWW-Authenticate", challenge);
    }
    let prefix = format!("/v2/{REPOSITORY}/");
    if let Some(reference) = request
        .path
        .strip_prefix(&prefix)
        .and_then(|p| p.strip_prefix("manifests/"))
    {
        let key = if reference == content.tag {
            content.index_digest.as_str()
        } else {
            reference
        };
        return match content.manifests.get(key) {
            Some((media_type, bytes)) => {
                Reply::new(200, bytes.clone()).header("Content-Type", media_type.clone())
            }
            None => Reply::new(404, "{}"),
        };
    }
    if let Some(blob) = request
        .path
        .strip_prefix(&prefix)
        .and_then(|p| p.strip_prefix("blobs/"))
    {
        // Layers are served through a same-origin storage redirect, as many registries do.
        if content.layer_digests.iter().any(|d| d == blob) {
            return Reply::new(307, "").header("Location", format!("/storage/{blob}"));
        }
        return match content.blobs.get(blob) {
            Some(bytes) => Reply::new(200, bytes.clone()),
            None => Reply::new(404, "{}"),
        };
    }
    if let Some(blob) = request.path.strip_prefix("/storage/") {
        return match content.blobs.get(blob) {
            Some(bytes) if tamper => {
                let mut bytes = bytes.clone();
                let last = bytes.len() - 1;
                bytes[last] ^= 1;
                Reply::new(200, bytes)
            }
            Some(bytes) => Reply::new(200, bytes.clone()),
            None => Reply::new(404, "{}"),
        };
    }
    Reply::new(404, "{}")
}

struct Output(PathBuf);
impl Output {
    fn new() -> Self {
        Self(crate::private_test_root(
            &std::env::temp_dir(),
            "hkg-registry-out",
        ))
    }
    fn archive(&self) -> PathBuf {
        self.0.join("image.tar")
    }
    fn entries(&self) -> usize {
        fs::read_dir(&self.0).unwrap().count()
    }
}
impl Drop for Output {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn empty_docker() -> DockerFixture {
    DockerFixture::new(&serde_json::json!({}))
}

#[test]
fn anonymous_registry_index_streams_zstd_and_gzip_layers_into_a_validated_archive() {
    let content = content();
    let registry = Registry::start(content.clone(), Auth::None, false);
    let docker = empty_docker();
    let policy = registry.policy(&docker);
    let tagged = format!("{}/{REPOSITORY}:v1", registry.domain());
    let admitted = admit(&tagged, &policy).unwrap();
    assert_eq!(
        (admitted.reference.as_str(), admitted.kind),
        (tagged.as_str(), "registry")
    );
    let resolved = resolve(&tagged, &policy).unwrap();
    assert_eq!(
        resolved.pinned_reference,
        format!(
            "{}/{REPOSITORY}@{}",
            registry.domain(),
            content.index_digest
        )
    );
    assert_eq!(resolved.manifest_digest, content.manifest_digest);
    assert_eq!(resolved.image_id, content.config_digest);
    let output = Output::new();
    let acquired = acquire(
        &resolved.pinned_reference,
        &output.archive(),
        &policy,
        policy.archive_limit,
    )
    .unwrap();
    assert_eq!(acquired.source_digest, content.index_digest);
    assert_eq!(acquired.manifest_digest, content.manifest_digest);
    assert_eq!(acquired.image_id, content.config_digest);
    let bytes = fs::read(output.archive()).unwrap();
    assert_eq!(bytes.len() as u64, acquired.archive_bytes);
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        acquired.archive_sha256
    );
    assert_eq!(
        image_load::validate_file(
            &output.archive(),
            &acquired.archive_sha256,
            &acquired.image_id,
            &policy
        )
        .unwrap(),
        acquired.archive_bytes
    );
    // Only the final archive remains, the decoy platform was never fetched, and no
    // request carried credentials to a registry that never asked for them.
    assert_eq!(output.entries(), 1);
    let requests = registry.requests();
    assert!(
        requests
            .iter()
            .all(|r| r.authorization.is_none() && r.method == "GET")
    );
    let decoy = content
        .manifests
        .keys()
        .find(|d| **d != content.index_digest && **d != content.manifest_digest)
        .unwrap();
    assert!(!requests.iter().any(|r| r.path.contains(decoy.as_str())));
    // An existing output is never replaced.
    assert!(
        acquire(
            &resolved.pinned_reference,
            &output.archive(),
            &policy,
            policy.archive_limit
        )
        .is_err()
    );
    assert_eq!(fs::read(output.archive()).unwrap(), bytes);
}

#[test]
fn bearer_challenges_try_an_anonymous_token_before_the_users_docker_credentials() {
    let content = content();
    let registry = Registry::start(content.clone(), Auth::Bearer, false);
    let pinned = format!(
        "{}/{REPOSITORY}@{}",
        registry.domain(),
        content.index_digest
    );
    // Without configured credentials the challenge refuses with a value-free message.
    let docker = empty_docker();
    let output = Output::new();
    let failure = acquire(
        &pinned,
        &output.archive(),
        &registry.policy(&docker),
        u64::MAX,
    )
    .unwrap_err();
    assert_eq!(failure.code, "registry_image");
    assert!(
        failure.message.contains("requires credentials"),
        "{failure:?}"
    );
    assert_eq!(output.entries(), 0);
    // With an `auths` entry the second token request carries Basic credentials, and only
    // registry-origin requests carry the resulting bearer token.
    let docker = DockerFixture::new(&serde_json::json!({"auths": {
        registry.domain(): {"auth": base64::engine::general_purpose::STANDARD.encode(format!("{USER}:{PASSWORD}"))}
    }}));
    let acquired = acquire(
        &pinned,
        &output.archive(),
        &registry.policy(&docker),
        u64::MAX,
    )
    .unwrap();
    assert_eq!(acquired.image_id, content.config_digest);
    let tokens: Vec<_> = registry
        .requests()
        .into_iter()
        .filter(|r| r.path.starts_with("/token"))
        .collect();
    assert!(tokens.len() >= 3);
    assert!(tokens.iter().all(|r| {
        r.path
            .contains("scope=repository%3Ateam%2Fsub%2Fapp%3Apull")
            && r.path.contains("service=fixture-registry")
    }));
    let last = tokens.len() - 2..;
    assert_eq!(tokens[last.start].authorization, None);
    assert_eq!(
        tokens[last.start + 1].authorization.as_deref(),
        Some(basic_value().as_str())
    );
    let failure = format!("{failure:?}{acquired:?}");
    assert!(!failure.contains(PASSWORD) && !failure.contains("pull-token"));
}

#[test]
fn identity_tokens_use_the_oauth_refresh_grant_and_basic_challenges_use_helpers() {
    let content = content();
    let registry = Registry::start(content.clone(), Auth::Basic, false);
    let pinned = format!(
        "{}/{REPOSITORY}@{}",
        registry.domain(),
        content.index_digest
    );
    let docker =
        DockerFixture::new(&serde_json::json!({"credHelpers": {registry.domain(): "fixture"}}));
    docker.helper(
        "fixture",
        &format!(r#"read -r server || true; printf '{{"ServerURL":"%s","Username":"{USER}","Secret":"{PASSWORD}"}}' "$server""#),
    );
    let output = Output::new();
    acquire(
        &pinned,
        &output.archive(),
        &registry.policy(&docker),
        u64::MAX,
    )
    .unwrap();
    // Wrong helper credentials refuse after one credentialed attempt.
    let docker = DockerFixture::new(&serde_json::json!({"credsStore": "wrong"}));
    docker.helper("wrong", r#"printf '{"Username":"u","Secret":"not-it"}'"#);
    let output = Output::new();
    let failure = acquire(
        &pinned,
        &output.archive(),
        &registry.policy(&docker),
        u64::MAX,
    )
    .unwrap_err();
    assert!(failure.message.contains("refused access"), "{failure:?}");
    assert!(!failure.message.contains("not-it"));
    assert_eq!(output.entries(), 0);

    // A Bearer realm with an identity token gets a form POST refresh grant.
    let registry = Registry::start(content.clone(), Auth::Bearer, false);
    let pinned = format!(
        "{}/{REPOSITORY}@{}",
        registry.domain(),
        content.index_digest
    );
    let docker = DockerFixture::new(
        &serde_json::json!({"auths": {registry.domain(): {"identitytoken": "refresh-fixture"}}}),
    );
    let output = Output::new();
    // The fixture realm grants pull tokens only for Basic credentials, so the refresh
    // grant is refused; the request shape is what is checked here.
    assert!(
        acquire(
            &pinned,
            &output.archive(),
            &registry.policy(&docker),
            u64::MAX
        )
        .is_err()
    );
    let grant = registry
        .requests()
        .into_iter()
        .find(|r| r.method == "POST")
        .unwrap();
    assert!(grant.path.starts_with("/token"));
    assert!(grant.body.contains("grant_type=refresh_token"));
    assert!(grant.body.contains("refresh_token=refresh-fixture"));
    assert!(grant.body.contains("service=fixture-registry"));
}

#[test]
fn the_budget_refuses_before_any_layer_transfer_and_tampered_layers_publish_nothing() {
    let content = content();
    let registry = Registry::start(content.clone(), Auth::None, false);
    let docker = empty_docker();
    let policy = registry.policy(&docker);
    let pinned = format!(
        "{}/{REPOSITORY}@{}",
        registry.domain(),
        content.index_digest
    );
    let output = Output::new();
    let failure = acquire(&pinned, &output.archive(), &policy, 16 * 1024).unwrap_err();
    assert!(failure.message.contains("budget"), "{failure:?}");
    assert_eq!(output.entries(), 0);
    let requests = registry.requests();
    assert!(!requests.iter().any(|r| {
        content
            .layer_digests
            .iter()
            .any(|d| r.path.contains(d.as_str()))
    }));

    let registry = Registry::start(content.clone(), Auth::None, true);
    let policy = registry.policy(&docker);
    let pinned = format!(
        "{}/{REPOSITORY}@{}",
        registry.domain(),
        content.index_digest
    );
    let failure = acquire(&pinned, &output.archive(), &policy, u64::MAX).unwrap_err();
    assert!(failure.message.contains("digest"), "{failure:?}");
    assert_eq!(output.entries(), 0);
    // A manifest that does not hash to its pin refuses too.
    let wrong = format!(
        "{}/{REPOSITORY}@{}",
        registry.domain(),
        content.manifest_digest.replace('a', "b").replace('1', "2")
    );
    assert!(acquire(&wrong, &output.archive(), &policy, u64::MAX).is_err());
    assert_eq!(output.entries(), 0);
}

#[test]
fn local_registries_refuse_without_an_explicit_opt_in_and_no_request_is_made() {
    let content = content();
    let registry = Registry::start(content.clone(), Auth::None, false);
    let docker = empty_docker();
    let pinned = format!(
        "{}/{REPOSITORY}@{}",
        registry.domain(),
        content.index_digest
    );
    let output = Output::new();
    for policy in [
        docker.policy(),
        // An HTTPS opt-in does not permit plain HTTP to the same registry.
        ImagePolicy {
            local_registries: vec![LocalRegistry {
                domain: registry.domain(),
                plain_http: false,
            }],
            ..docker.policy()
        },
    ] {
        let refused = acquire(&pinned, &output.archive(), &policy, u64::MAX);
        assert!(refused.is_err());
    }
    let failure = admit(&pinned, &docker.policy()).unwrap_err();
    assert_eq!(failure.code, "registry_image");
    assert!(!failure.message.contains(&registry.domain()));
    assert!(
        resolve(
            &format!("{}/{REPOSITORY}:v1", registry.domain()),
            &docker.policy()
        )
        .is_err()
    );
    assert!(registry.requests().is_empty());
    assert_eq!(output.entries(), 0);
}

#[test]
fn local_hosts_are_classified_before_any_request() {
    for host in [
        "localhost",
        "app.localhost",
        "printer.local",
        "registry",
        "127.0.0.1",
        "127.1.2.3",
        "0.0.0.0",
        "10.1.2.3",
        "100.64.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "224.0.0.1",
        "2130706433",
    ] {
        assert!(local_host(host), "{host}");
    }
    for host in [
        "ghcr.io",
        "registry.example.com",
        "registry.internal.example",
        "172.32.0.1",
        "100.128.0.1",
        "8.8.8.8",
    ] {
        assert!(!local_host(host), "{host}");
    }
    let policy = ImagePolicy::default();
    let pin = format!("sha256:{}", "a".repeat(64));
    // Numeric host spellings normalize to loopback before classification.
    for reference in [
        format!("0x7f.0.0.1/a@{pin}"),
        format!("127.0.0.1:5000/a@{pin}"),
        format!("localhost/a@{pin}"),
        format!("registry:5000/a@{pin}"),
    ] {
        assert_eq!(
            pinned(&reference, &policy).err().unwrap().code,
            "registry_image",
            "{reference}"
        );
    }
}

#[test]
fn redirects_and_token_realms_cannot_downgrade_or_reach_local_origins() {
    let policy = ImagePolicy::default();
    let pin = format!("sha256:{}", "a".repeat(64));
    let hub = pinned(&format!("alpine@{pin}"), &policy).unwrap().registry;
    let other = pinned(&format!("ghcr.io/org/app@{pin}"), &policy)
        .unwrap()
        .registry;
    let url = |value: &str| Url::parse(value).unwrap();
    for value in [
        "https://registry-1.docker.io/v2/",
        "https://production.cloudflare.docker.com/blob?opaque=private",
        "https://docker-images-prod.abc.r2.cloudflarestorage.com/blob",
    ] {
        assert!(redirect_allowed(&hub, &url(value)), "{value}");
    }
    for value in [
        "http://production.cloudflare.docker.com/blob",
        "https://127.0.0.1/blob",
        "https://registry-1.docker.io:444/blob",
        "https://registry-1.docker.io.evil.test/blob",
        "https://user:secret@registry-1.docker.io/blob",
        "https://storage.example.com/blob",
    ] {
        assert!(!redirect_allowed(&hub, &url(value)), "{value}");
    }
    for value in [
        "https://ghcr.io/v2/org/app/blobs/x",
        "https://pkg-storage.example.com/blob?signature=opaque",
        "https://203.0.113.5/blob",
    ] {
        assert!(redirect_allowed(&other, &url(value)), "{value}");
    }
    for value in [
        "http://pkg-storage.example.com/blob",
        "https://pkg-storage.example.com:8443/blob",
        "https://localhost/blob",
        "https://10.0.0.5/blob",
        "https://169.254.169.254/latest",
        "https://0x7f.0.0.1/blob",
        "https://[::1]/blob",
        "https://user:secret@pkg-storage.example.com/blob",
        "https://metadata/blob",
    ] {
        assert!(!redirect_allowed(&other, &url(value)), "{value}");
    }
    assert!(realm_allowed(&hub, &url("https://auth.docker.io/token")));
    assert!(!realm_allowed(&hub, &url("https://auth.example.com/token")));
    assert!(realm_allowed(&other, &url("https://ghcr.io/token")));
    assert!(realm_allowed(
        &other,
        &url("https://auth.example.com/token")
    ));
    for value in [
        "http://auth.example.com/token",
        "https://localhost/token",
        "https://10.0.0.1/token",
        "https://user:pw@auth.example.com/token",
    ] {
        assert!(!realm_allowed(&other, &url(value)), "{value}");
    }
}

/// Treats `origins` as public HTTPS hosts for this test thread, standing in for foreign
/// storage and token hosts that the loopback fixtures cannot serve over TLS.
struct PublicOrigins;
impl PublicOrigins {
    fn new(origins: &[&Registry]) -> Self {
        TEST_PUBLIC_ORIGINS.with(|list| {
            *list.borrow_mut() = origins
                .iter()
                .map(|r| Url::parse(&r.origin()).unwrap())
                .collect();
        });
        Self
    }
}
impl Drop for PublicOrigins {
    fn drop(&mut self) {
        TEST_PUBLIC_ORIGINS.with(|list| list.borrow_mut().clear());
    }
}

fn credentials_for(registry: &Registry) -> DockerFixture {
    DockerFixture::new(&serde_json::json!({"auths": {
        registry.domain(): {"auth": base64::engine::general_purpose::STANDARD.encode(format!("{USER}:{PASSWORD}"))}
    }}))
}

#[test]
fn a_redirected_storage_host_challenge_never_reaches_a_token_realm_or_credentials() {
    let content = content();
    // The foreign storage host refuses every request with a Bearer realm it controls.
    let storage = Registry::serve(Box::new(|request, port| {
        if request.path.starts_with("/token") {
            return Reply::new(200, r#"{"token":"storage-token"}"#);
        }
        Reply::new(401, "{}").header(
            "WWW-Authenticate",
            format!(r#"Bearer realm="http://127.0.0.1:{port}/token",service="storage""#),
        )
    }));
    let storage_origin = storage.origin();
    let served = content.clone();
    let registry = Registry::serve(Box::new(move |request, port| {
        let layer = request
            .path
            .strip_prefix(&format!("/v2/{REPOSITORY}/blobs/"))
            .filter(|blob| served.layer_digests.iter().any(|d| d == blob));
        match layer {
            Some(blob) => {
                Reply::new(307, "").header("Location", format!("{storage_origin}/storage/{blob}"))
            }
            None => respond(&served, Auth::None, false, port, request),
        }
    }));
    let _public = PublicOrigins::new(&[&storage]);
    let docker = credentials_for(&registry);
    let pinned = format!(
        "{}/{REPOSITORY}@{}",
        registry.domain(),
        content.index_digest
    );
    let output = Output::new();
    let failure = acquire(
        &pinned,
        &output.archive(),
        &registry.policy(&docker),
        u64::MAX,
    )
    .unwrap_err();
    assert_eq!(failure.code, "registry_redirect_refused", "{failure:?}");
    assert_eq!(output.entries(), 0);
    // The storage host saw one unauthenticated blob request and no token request; the
    // registry's own realm was never asked either.
    let requests = storage.requests();
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert!(requests[0].path.starts_with("/storage/") && requests[0].authorization.is_none());
    assert!(
        registry
            .requests()
            .iter()
            .all(|r| !r.path.starts_with("/token") && r.authorization.is_none())
    );
}

#[test]
fn a_foreign_token_realm_gets_anonymous_requests_but_never_the_users_credentials() {
    let content = content();
    // A foreign realm that would grant a pull token for the user's credentials.
    let realm = Registry::serve(Box::new(|request, _| {
        match request.authorization.as_deref() {
            None => Reply::new(200, r#"{"token":"anonymous-token"}"#),
            Some(_) => Reply::new(200, r#"{"token":"pull-token"}"#),
        }
    }));
    let realm_origin = realm.origin();
    let served = content.clone();
    let registry = Registry::serve(Box::new(move |request, port| {
        if request.authorization.as_deref() == Some("Bearer pull-token") {
            return respond(&served, Auth::None, false, port, request);
        }
        Reply::new(401, "{}").header(
            "WWW-Authenticate",
            format!(r#"Bearer realm="{realm_origin}/token",service="fixture-registry""#),
        )
    }));
    let _public = PublicOrigins::new(&[&realm]);
    let pinned = format!(
        "{}/{REPOSITORY}@{}",
        registry.domain(),
        content.index_digest
    );
    for docker in [
        credentials_for(&registry),
        DockerFixture::new(
            &serde_json::json!({"auths": {registry.domain(): {"identitytoken": "refresh-fixture"}}}),
        ),
    ] {
        let output = Output::new();
        let failure = acquire(
            &pinned,
            &output.archive(),
            &registry.policy(&docker),
            u64::MAX,
        )
        .unwrap_err();
        assert_eq!(failure.code, "registry_realm_refused", "{failure:?}");
        assert_eq!(output.entries(), 0);
    }
    let requests = realm.requests();
    assert!(!requests.is_empty());
    assert!(
        requests
            .iter()
            .all(|r| r.method == "GET" && r.authorization.is_none() && !r.body.contains("refresh")),
        "{requests:?}"
    );
}

#[test]
fn credentialed_realms_are_limited_to_the_registry_host_and_its_parent_domains() {
    let policy = ImagePolicy::default();
    let pin = format!("sha256:{}", "a".repeat(64));
    let registry = |reference: &str| {
        pinned(&format!("{reference}/org/app@{pin}"), &policy)
            .unwrap()
            .registry
    };
    let url = |value: &str| Url::parse(value).unwrap();
    let hub = pinned(&format!("alpine@{pin}"), &policy).unwrap().registry;
    assert!(credential_realm_allowed(&hub, &url(DOCKER_HUB_REALM)));
    let gitlab = registry("registry.gitlab.com");
    for value in [
        "https://registry.gitlab.com/jwt/auth",
        "https://gitlab.com/jwt/auth",
    ] {
        assert!(credential_realm_allowed(&gitlab, &url(value)), "{value}");
    }
    let ported = registry("registry.example.com:8443");
    assert!(credential_realm_allowed(
        &ported,
        &url("https://registry.example.com:8443/token")
    ));
    assert!(credential_realm_allowed(
        &ported,
        &url("https://example.com/token")
    ));
    for value in [
        // Anonymous requests may go to any public realm; credentials may not.
        "https://auth.gitlab.com/jwt/auth",
        "https://evil.example/token",
        "https://gitlab.com.evil.example/token",
        "https://com/token",
        "https://gitlab.com:8443/jwt/auth",
        "http://gitlab.com/jwt/auth",
        "https://203.0.113.5/token",
    ] {
        assert!(!credential_realm_allowed(&gitlab, &url(value)), "{value}");
    }
    assert!(realm_allowed(&gitlab, &url("https://evil.example/token")));
}

#[test]
fn public_names_resolving_to_local_addresses_refuse_unless_the_registry_is_allowed() {
    let content = content();
    let registry = Registry::start(content.clone(), Auth::None, false);
    let table: BTreeMap<&str, IpAddr> = [
        ("registry.example.test", "127.0.0.1"),
        ("private.example.test", "10.0.0.7"),
        ("mapped.example.test", "::ffff:127.0.0.1"),
        ("ula.example.test", "fd00::1"),
    ]
    .into_iter()
    .map(|(name, ip)| (name, ip.parse().unwrap()))
    .collect();
    let lookup = HostLookup(Arc::new(move |name| {
        table
            .get(name)
            .map(|ip| vec![*ip])
            .ok_or_else(|| std::io::Error::other("unknown fixture host"))
    }));
    let docker = empty_docker();
    let policy = |opt_in: Option<String>| ImagePolicy {
        host_lookup: Some(lookup.clone()),
        local_registries: opt_in
            .map(|domain| LocalRegistry {
                domain,
                plain_http: true,
            })
            .into_iter()
            .collect(),
        ..docker.policy()
    };
    for host in [
        "registry.example.test",
        "private.example.test",
        "mapped.example.test",
        "ula.example.test",
    ] {
        let reference = format!("{host}:{}/{REPOSITORY}:v1", registry.port);
        // The name looks public, so admission (which does no resolution) accepts it.
        assert_eq!(admit(&reference, &policy(None)).unwrap().kind, "registry");
        let failure = resolve(&reference, &policy(None)).unwrap_err();
        assert_eq!(
            failure.code, "registry_local_address",
            "{host}: {failure:?}"
        );
        // An opt-in for a different registry does not allow this one.
        let other = policy(Some(format!("other.example.test:{}", registry.port)));
        assert_eq!(
            resolve(&reference, &other).unwrap_err().code,
            "registry_local_address"
        );
    }
    assert!(registry.requests().is_empty());
    // An explicit opt-in allows exactly that registry, through the injected lookup.
    let domain = format!("registry.example.test:{}", registry.port);
    let allowed = policy(Some(domain.clone()));
    let resolved = resolve(&format!("{domain}/{REPOSITORY}:v1"), &allowed).unwrap();
    assert_eq!(resolved.image_id, content.config_digest);
    assert!(!registry.requests().is_empty());
}

#[test]
fn ip_literals_are_checked_by_address_before_any_request() {
    for ip in [
        "127.0.0.1",
        "10.0.0.1",
        "100.64.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "192.168.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "::127.0.0.1",
        "64:ff9b::a00:1",
        "2002:7f00:1::",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "fec0::1",
        "ff02::1",
    ] {
        assert!(!public_ip(ip.parse().unwrap()), "{ip}");
    }
    for ip in [
        "8.8.8.8",
        "203.0.113.5",
        "2606:4700::1111",
        "::ffff:8.8.8.8",
        "2002:808:808::",
    ] {
        assert!(public_ip(ip.parse().unwrap()), "{ip}");
    }
    let policy = ImagePolicy::default();
    let pin = format!("sha256:{}", "a".repeat(64));
    let public = pinned(&format!("ghcr.io/org/app@{pin}"), &policy).unwrap();
    let fetch = Fetch::new(&public.registry, &public.path, &policy).unwrap();
    let url = |value: &str| Url::parse(value).unwrap();
    for value in [
        "https://127.0.0.1/blob",
        "https://[::1]/blob",
        "https://[::ffff:127.0.0.1]/blob",
        "https://[fd00::1]/blob",
        "https://10.0.0.1/token",
    ] {
        assert!(!fetch.destination_allowed(&url(value)), "{value}");
    }
    for value in ["https://ghcr.io/v2/", "https://203.0.113.5/blob"] {
        assert!(fetch.destination_allowed(&url(value)), "{value}");
    }
    // A local opt-in allows its own origin only, not its host on another port.
    let allowed =
        ImagePolicy::from_flags(&["--allow-local-registry", "http://127.0.0.1:5000"]).unwrap();
    let local = pinned(&format!("127.0.0.1:5000/org/app@{pin}"), &allowed).unwrap();
    let fetch = Fetch::new(&local.registry, &local.path, &allowed).unwrap();
    assert!(fetch.destination_allowed(&url("http://127.0.0.1:5000/v2/")));
    assert!(!fetch.destination_allowed(&url("http://127.0.0.1:5001/v2/")));
    let allowed =
        ImagePolicy::from_flags(&["--allow-local-registry", "registry.corp.example:5000"]).unwrap();
    let named = pinned(
        &format!("registry.corp.example:5000/org/app@{pin}"),
        &allowed,
    )
    .unwrap();
    let fetch = Fetch::new(&named.registry, &named.path, &allowed).unwrap();
    assert!(fetch.destination_allowed(&url("https://registry.corp.example:5000/v2/")));
    assert!(!fetch.destination_allowed(&url("https://registry.corp.example/blob")));
}

#[test]
fn authentication_challenges_parse_quoted_parameters() {
    let challenge = parse_challenge(
        r#"Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:a/b:pull,push""#,
    )
    .unwrap();
    assert!(challenge.bearer);
    assert_eq!(
        challenge.realm.as_deref(),
        Some("https://auth.example.com/token")
    );
    assert_eq!(challenge.service.as_deref(), Some("registry.example.com"));
    let challenge = parse_challenge(r#"basic realm="x\"y""#).unwrap();
    assert!(!challenge.bearer);
    assert_eq!(challenge.realm.as_deref(), Some("x\"y"));
    for value in ["Negotiate abc", "Bearer realm=\"unterminated", ""] {
        assert!(parse_challenge(value).is_err(), "{value}");
    }
}

#[test]
fn mutable_resolution_is_explicit_and_rejects_non_repository_inputs() {
    let policy = ImagePolicy::default();
    let resolved = |value: &str| {
        let (registry, path, tag) = tagged(value, &policy).unwrap();
        (registry.domain, path, tag)
    };
    let owned =
        |domain: &str, path: &str, tag: &str| (domain.to_owned(), path.to_owned(), tag.to_owned());
    assert_eq!(
        resolved("bitnami/redis"),
        owned("docker.io", "bitnami/redis", "latest")
    );
    assert_eq!(
        resolved("docker.io/chromedp/headless-shell:stable"),
        owned("docker.io", "chromedp/headless-shell", "stable")
    );
    assert_eq!(
        resolved("alpine:3.21"),
        owned("docker.io", "library/alpine", "3.21")
    );
    assert_eq!(resolved("ghcr.io/a/b:tag"), owned("ghcr.io", "a/b", "tag"));
    assert_eq!(
        resolved("registry.example.com:8443/team/sub/app"),
        owned("registry.example.com:8443", "team/sub/app", "latest")
    );
    for value in [
        "Redis",
        "localhost:5000/a:tag",
        "a/b/c:tag",
        format!("sha256:{}", "e".repeat(64)).as_str(),
        "https://docker.io/a/b:tag",
        "a/b@sha256:bad",
        "a/b:",
        "a/b:-bad",
        "a/b:foo?bar",
        "a/b:foo/bar",
        "a/..:tag",
        "a/b:PRIVATE CANARY",
    ] {
        assert!(tagged(value, &policy).is_err(), "{value}");
    }
    assert!(pinned("bitnami/redis:latest", &policy).is_err());
}

#[test]
fn resolution_requires_unambiguous_linux_arm64_and_actual_config_architecture() {
    let bytes = br#"{"schemaVersion":2,"manifests":[{"digest":"sha256:unused","size":10,"mediaType":"application/vnd.oci.image.manifest.v1+json","platform":{"os":"linux","architecture":"amd64"}}]}"#;
    assert!(arm64(&parse_manifest(bytes, &digest(bytes)).unwrap()).is_err());
    for bytes in [
        br#"{"os":"linux","architecture":"arm64"}"#.as_slice(),
        br#"{"os":"linux","architecture":"arm64","variant":"v8"}"#.as_slice(),
    ] {
        assert!(verify_platform(bytes).is_ok());
    }
    for bytes in [
        br#"{"os":"linux","architecture":"amd64"}"#.as_slice(),
        br#"{"os":"linux","architecture":"arm64","variant":"v9"}"#.as_slice(),
        br#"{"os":"darwin","architecture":"arm64"}"#.as_slice(),
    ] {
        assert!(verify_platform(bytes).is_err());
    }
    let descriptor = serde_json::json!({"digest":"sha256:unused","size":10,"mediaType":"application/vnd.oci.image.manifest.v1+json","platform":{"os":"linux","architecture":"arm64"}});
    let bytes = serde_json::to_vec(
        &serde_json::json!({"schemaVersion":2,"manifests":[descriptor.clone(),descriptor]}),
    )
    .unwrap();
    assert!(arm64(&parse_manifest(&bytes, &digest(&bytes)).unwrap()).is_err());
    // A nested index or a non-image artifact is not an ARM64 image manifest.
    let nested = serde_json::json!({"digest":"sha256:unused","size":10,"mediaType":"application/vnd.oci.image.index.v1+json","platform":{"os":"linux","architecture":"arm64"}});
    let bytes =
        serde_json::to_vec(&serde_json::json!({"schemaVersion":2,"manifests":[nested]})).unwrap();
    assert!(arm64(&parse_manifest(&bytes, &digest(&bytes)).unwrap()).is_err());
    let bytes = br#"{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","config":{"digest":"sha256:unused","size":1}}"#;
    assert!(parse_manifest(bytes, &digest(bytes)).is_err());
}

#[test]
fn layer_media_types_cover_gzip_zstd_and_uncompressed_and_refuse_foreign_layers() {
    for (media_type, extension) in [
        ("application/vnd.oci.image.layer.v1.tar+gzip", "tar.gz"),
        (
            "application/vnd.docker.image.rootfs.diff.tar.gzip",
            "tar.gz",
        ),
        ("application/vnd.oci.image.layer.v1.tar+zstd", "tar.zst"),
        ("application/vnd.oci.image.layer.v1.tar", "tar"),
    ] {
        assert_eq!(layer_extension(media_type).unwrap(), extension);
    }
    for media_type in [
        "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip",
        "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip",
        "application/vnd.oci.image.config.v1+json",
        "",
    ] {
        assert!(layer_extension(media_type).is_err(), "{media_type}");
    }
    let mut descriptor = Descriptor {
        digest: digest(b"x"),
        size: 1,
        media_type: String::new(),
        platform: None,
        urls: vec!["https://example.com/layer".into()],
    };
    assert!(Fetch::checked(&descriptor, 10).is_err());
    descriptor.urls.clear();
    assert!(Fetch::checked(&descriptor, 10).is_ok());
    assert!(Fetch::checked(&descriptor, 0).is_err());
}

#[test]
fn pinned_references_normalize_and_keep_any_registry_path() {
    let policy = ImagePolicy::default();
    let pin = format!("sha256:{}", "a".repeat(64));
    for (input, canonical) in [
        (
            format!("imbios/bun-node:1.3-alpine@{pin}"),
            format!("docker.io/imbios/bun-node@{pin}"),
        ),
        (
            format!("alpine@{pin}"),
            format!("docker.io/library/alpine@{pin}"),
        ),
        (
            format!("docker.io/alpine:3.21@{pin}"),
            format!("docker.io/library/alpine@{pin}"),
        ),
        (
            format!("ghcr.io/org/app:v1@{pin}"),
            format!("ghcr.io/org/app@{pin}"),
        ),
        (
            format!("registry.example.com:8443/team/sub/app@{pin}"),
            format!("registry.example.com:8443/team/sub/app@{pin}"),
        ),
    ] {
        let value = pinned(&input, &policy).unwrap();
        assert_eq!(value.canonical(), canonical);
        assert_eq!(value.digest, pin);
        assert_eq!(pinned_syntax(&input).unwrap(), (canonical, pin.clone()));
    }
    // Recorded local entries stay readable by syntax under any policy.
    assert!(pinned_syntax(&format!("localhost:5000/a@{pin}")).is_ok());
    for value in [
        format!("Imbios/bun-node@{pin}"),
        "imbios/bun-node:latest".to_owned(),
        "https://docker.io/a/b".to_owned(),
        "user:secret@docker.io/a/b".to_owned(),
        "example.com/a/b@sha256:bad".to_owned(),
        "../bad@sha256:bad".to_owned(),
        format!("docker.io/a/b/c@{pin}"),
    ] {
        assert!(pinned(&value, &policy).is_err(), "{value}");
    }
}

#[test]
fn admission_normalizes_references_and_refuses_unacquirable_ones_without_echoing_them() {
    let policy = ImagePolicy::default();
    let pin = format!("sha256:{}", "a".repeat(64));
    let id = format!("sha256:{}", "e".repeat(64));
    for (input, reference, kind) in [
        (
            "alpine",
            "docker.io/library/alpine:latest".to_owned(),
            "docker_hub",
        ),
        (
            "alpine:3.21",
            "docker.io/library/alpine:3.21".to_owned(),
            "docker_hub",
        ),
        (
            "user/img",
            "docker.io/user/img:latest".to_owned(),
            "docker_hub",
        ),
        (
            &*format!("alpine@{pin}"),
            format!("docker.io/library/alpine@{pin}"),
            "docker_hub",
        ),
        (
            "ghcr.io/org/app:v1",
            "ghcr.io/org/app:v1".to_owned(),
            "registry",
        ),
        (
            "quay.io/org/app",
            "quay.io/org/app:latest".to_owned(),
            "registry",
        ),
        (
            "registry.example.com/a/b/c:1",
            "registry.example.com/a/b/c:1".to_owned(),
            "registry",
        ),
        (id.as_str(), id.clone(), "image_id"),
    ] {
        let admitted = admit(input, &policy).unwrap();
        assert_eq!(
            (admitted.reference.as_str(), admitted.kind),
            (reference.as_str(), kind),
            "{input}"
        );
    }
    let allowed =
        ImagePolicy::from_flags(&["--allow-local-registry", "http://localhost:5000"]).unwrap();
    assert_eq!(
        admit("localhost:5000/private-canary", &allowed)
            .unwrap()
            .kind,
        "registry"
    );
    for input in [
        "",
        "PRIVATE_CANARY",
        "localhost:5000/private-canary",
        "private-canary/nested/app",
        "private-canary@sha256:bad",
        "10.0.0.5:5000/private-canary",
    ] {
        let failure = admit(input, &policy).unwrap_err();
        assert_eq!(failure.code, "registry_image");
        assert!(!failure.message.to_ascii_lowercase().contains("canary"));
    }
}

#[test]
fn publication_preserves_existing_output_and_failed_writes_leave_no_final_file() {
    let root = Output::new();
    let output = root.archive();
    fs::write(&output, b"existing").unwrap();
    let write = |bytes: &'static [u8]| {
        move |file: &mut File| file.write_all(bytes).map_err(|_| error("write"))
    };
    assert!(publish(&output, write(b"replacement"), |_, _| Ok(())).is_err());
    assert_eq!(fs::read(&output).unwrap(), b"existing");
    fs::remove_file(&output).unwrap();
    assert!(
        publish(
            &output,
            |file| {
                file.write_all(b"partial").unwrap();
                Err::<(), _>(error("injected write failure"))
            },
            |_, _| Ok(())
        )
        .is_err()
    );
    assert!(!output.exists());
    // A verification failure after the write also publishes nothing.
    assert!(publish(&output, write(b"complete"), |_, _| Err(error("injected"))).is_err());
    assert_eq!(root.entries(), 0);
    publish(&output, write(b"complete"), |path, _| {
        assert_eq!(fs::read(path).unwrap(), b"complete");
        Ok(())
    })
    .unwrap();
    assert_eq!(fs::read(&output).unwrap(), b"complete");
    assert_eq!(root.entries(), 1);
}

#[test]
fn compressed_objects_require_both_exact_size_and_digest() {
    let mut descriptor = Descriptor {
        digest: digest(b"compressed fixture"),
        size: 18,
        media_type: String::new(),
        platform: None,
        urls: Vec::new(),
    };
    assert!(verify_object(&descriptor, b"compressed fixture").is_ok());
    assert!(verify_object(&descriptor, b"compressed fixturE").is_err());
    let read = |bytes: &[u8], descriptor: &Descriptor| {
        let mut out = Vec::new();
        Verified {
            inner: bytes,
            digest: Sha256::new(),
            total: 0,
            size: descriptor.size,
            expected: descriptor.digest.clone(),
        }
        .read_to_end(&mut out)
        .map(|_| out)
    };
    assert_eq!(
        read(b"compressed fixture", &descriptor).unwrap(),
        b"compressed fixture"
    );
    assert!(read(b"compressed fixturE", &descriptor).is_err());
    assert!(read(b"compressed fixture!", &descriptor).is_err());
    descriptor.size = 17;
    assert!(verify_object(&descriptor, b"compressed fixture").is_err());
    assert!(read(b"compressed fixture", &descriptor).is_err());
    let mut bytes = b"compressed fixture".to_vec();
    bytes.pop();
    descriptor.size = 18;
    assert!(read(&bytes, &descriptor).is_err());
    assert!(bounded(&b"12345"[..], 4).is_err());
    assert_eq!(bounded(&b"1234"[..], 4).unwrap(), b"1234");
}

#[test]
fn invalid_reference_refuses_without_creating_archive() {
    let root = Output::new();
    let output = root.archive();
    let failure =
        acquire("PRIVATE_CANARY", &output, &ImagePolicy::default(), u64::MAX).unwrap_err();
    assert!(!output.exists());
    assert!(!failure.message.contains("PRIVATE_CANARY"));
}

#[test]
#[ignore = "Explicit public Docker Hub acquisition; no runtime import"]
fn pinned_event_agent_image_downloads_without_docker() {
    let path = std::env::var("HACK_REGISTRY_TEST_ARCHIVE").expect("explicit new archive path");
    let policy = ImagePolicy::default();
    let receipt = acquire("imbios/bun-node:1.3.14-24-alpine@sha256:744fb75f37bbe5cca4ba5e9645c7e4454adb58e17752caf53dd61924123297dc", Path::new(&path), &policy, policy.archive_limit).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(bytes.len() as u64, receipt.archive_bytes);
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        receipt.archive_sha256
    );
    image_load::validate_file(
        Path::new(&path),
        &receipt.archive_sha256,
        &receipt.image_id,
        &policy,
    )
    .unwrap();
    println!("{}", serde_json::to_string(&receipt).unwrap());
}
