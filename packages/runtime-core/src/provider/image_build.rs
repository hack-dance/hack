//! Native Compose `build:` images: `runtime build-image`.
//!
//! One operation builds one image for one build key inside the guest engine, through
//! the pinned host BuildKit client (`docker-buildx`, docker driver) talking to the
//! engine's verified forwarded socket. The built image lands in the guest image store,
//! where graph admission already looks, and the caller pins the service to the content
//! ID it returns, so review, receipts and restore treat it like a pulled image.
//!
//! Authority and ownership:
//!
//! - The build key binds the local inputs: namespace (project root and branch), context
//!   and Dockerfile paths, the Dockerfile and `.dockerignore` bytes, target, salted
//!   argument hashes, platform, and the builder and engine versions. Context file
//!   contents are not hashed, as with Compose: an existing image is reused until an
//!   explicit rebuild. Base-image tags resolve only when a build runs.
//! - Every image the Dockerfile can pull (see [`super::build_scan`]) resolves to a digest
//!   before BuildKit runs and is handed to it as a named build context, so BuildKit pulls
//!   only those exact manifests. Base images with stored `ONBUILD` triggers refuse.
//! - The provider lease is held only for short admission and adoption steps, never while
//!   BuildKit runs. A shared build fence (`run/image-builds/active.lock`), taken under the
//!   lease and held for the whole operation, makes `runtime down` refuse instead of
//!   stopping the engine under a running build.
//! - A receipt `run/image-builds/<namespace>/<key>.json` records the attempt. Only a
//!   `content-id-verified` receipt from the same checkout, provider incarnation and
//!   engine, whose image still inspects with exactly the owned labels, is reused. A
//!   `building` receipt found under the per-key lock belongs to a dead attempt (the lock
//!   is released only when its holder exits): it is recorded `indeterminate` and the
//!   image is built again. Build outputs are content addressed and adoption always
//!   rechecks labels and incarnation, so no operator action is needed.
//! - Argument values never appear in argv, receipts, messages or output: the client
//!   receives `--build-arg NAME` and reads the value from its private environment.
//! - Nothing here removes images, prunes caches or adopts an image whose labels differ.
use super::{
    artifact,
    build_scan::{self, BaseImage},
    registry_image::{self, BuildBase},
    state,
};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Read,
    os::fd::AsRawFd,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[cfg(test)]
mod tests;

/// The default bridge range guest-daemon.sh gives egress pools; only builds use it.
pub(super) const BUILD_NETWORK_SUBNET: &str = "10.213.255.0/24";
const BUILD_NETWORK_MARKER: &str = "build-network-v1";
/// Repository for every Hack-built image; review never accepts it as an authored image.
pub const BUILD_REPOSITORY: &str = "hack-local-build";
const KIND: &str = "build-image";
const DEFAULT_TIMEOUT_SECONDS: u64 = 30 * 60;
const MAX_TIMEOUT_SECONDS: u64 = 2 * 60 * 60;
const CANCEL_GRACE: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(50);
const LEASE_WAIT: Duration = Duration::from_secs(5);
const MAX_REQUEST_BYTES: u64 = 192 * 1024;
const MAX_RECEIPT_BYTES: u64 = 16 * 1024;
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_IGNORE_BYTES: u64 = 1024 * 1024;
const MAX_ARGS: usize = 64;
const MAX_ARG_BYTES: usize = 64 * 1024;
/// Labels a Dockerfile (or a base image) must not set on an image Hack runs: the same
/// reserved ownership namespaces the frontend refuses on authored services.
const RESERVED_LABEL_PREFIXES: [&str; 5] = [
    "com.docker.compose.",
    "io.hack-local.",
    "io.hack.native-config.",
    "io.hack.native-file.",
    "io.hack.storage-witness.",
];

fn refusal(code: &'static str, message: &str) -> CandidateError {
    CandidateError::new(code, message)
}
fn invalid(message: &str) -> CandidateError {
    refusal("native_build_request", message)
}
fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn image_id(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(hex64)
}

/// When the caller wants a fresh build.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Policy {
    /// Reuse a verified image for this build key; build only when it is missing.
    Missing,
    /// Always build (BuildKit's cache keeps unchanged steps cheap) and re-resolve bases.
    Rebuild,
}

/// The private request file. It is read only from a singly linked 0600 file owned by
/// this user, because argument values are in it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildRequest {
    pub version: u32,
    /// Exact canonical project root; the namespace is derived from it and `branch`.
    pub project_root: PathBuf,
    #[serde(default)]
    pub branch: Option<String>,
    /// Build context, relative to the project root.
    pub context: String,
    /// Dockerfile, relative to the context.
    #[serde(default = "default_dockerfile")]
    pub dockerfile: String,
    #[serde(default)]
    pub target: Option<String>,
    /// Literal build arguments. Values are secrets for every output purpose.
    #[serde(default)]
    pub args: BTreeMap<String, String>,
    pub policy: Policy,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
}
fn default_dockerfile() -> String {
    "Dockerfile".into()
}

/// The result of one `runtime build-image`.
#[derive(Debug, Serialize)]
pub struct BuildOutcome {
    pub image_id: String,
    pub build_key: String,
    pub tag: String,
    /// True when a verified image was reused without running the builder.
    pub reused: bool,
    /// Named build context to the pinned reference it resolved to, for this image.
    pub base_pins: BTreeMap<String, String>,
}

/// Receipt phases. `building` with no live holder of the key lock is a dead attempt.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Phase {
    Building,
    ContentIdVerified,
    Failed,
    Canceled,
    Indeterminate,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Receipt {
    version: u32,
    checkout: PathBuf,
    namespace: String,
    build_key: String,
    provider_incarnation: String,
    provider_boot_id: String,
    engine_id: String,
    phase: Phase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image_id: Option<String>,
    base_pins: BTreeMap<String, String>,
}

/// The pool identity a build is admitted against and must find unchanged at adoption.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PoolIdentity {
    pub incarnation: String,
    pub boot_id: String,
    pub engine_id: String,
    /// Host path of the verified forwarded engine socket.
    pub socket: PathBuf,
}

/// The effects a build needs from the provider. The live implementation holds the
/// provider lease inside `Lease`; tests substitute a fake pool and a fake builder.
pub(super) trait BuildPool {
    type Lease;
    /// Take the provider lease, verify the running pool, its build network and engine.
    fn lease(&self) -> Result<(Self::Lease, PoolIdentity), CandidateError>;
    /// Inspect one image by content ID or tag; `None` when the engine reports it absent.
    fn inspect(&self, lease: &Self::Lease, image: &str) -> Result<Option<Value>, CandidateError>;
    /// Resolve one base image to its pinned manifest. Network only; no lease is held.
    fn resolve(&self, base: &BaseImage) -> Result<BuildBase, CandidateError>;
    /// The verified builder executable.
    fn builder(&self) -> Result<PathBuf, CandidateError>;
}

/// Validated local inputs and the build key derived from them.
#[derive(Debug)]
pub(super) struct Inputs {
    namespace: String,
    key: String,
    context: PathBuf,
    dockerfile: PathBuf,
    target: Option<String>,
    args: BTreeMap<String, String>,
    images: Vec<BaseImage>,
    policy: Policy,
    timeout: Duration,
}

impl Inputs {
    fn tag(&self) -> String {
        format!(
            "{BUILD_REPOSITORY}/{}:{}",
            &self.namespace[..12],
            &self.key[..32]
        )
    }
}

/// The non-secret owner value an image carries: a digest of the pool incarnation, so
/// the incarnation itself never reaches the client's argv.
pub(super) fn owner_label(incarnation: &str) -> String {
    sha256_hex(format!("hack-native-build-owner-v1\0{incarnation}").as_bytes())[..32].to_owned()
}

fn labels(inputs: &Inputs, identity: &PoolIdentity) -> BTreeMap<&'static str, String> {
    BTreeMap::from([
        ("io.hack-local.build-key", inputs.key.clone()),
        ("io.hack-local.kind", KIND.to_owned()),
        ("io.hack-local.namespace", inputs.namespace.clone()),
        ("io.hack-local.owner", owner_label(&identity.incarnation)),
    ])
}

/// The namespace builds for one project root and branch belong to. Worktrees and
/// branches sharing one pool get distinct namespaces, so images never cross them.
pub(super) fn namespace(root: &Path, branch: Option<&str>) -> String {
    let mut digest = Sha256::new();
    digest.update(b"hack-native-build-namespace-v1\0");
    digest.update(root.as_os_str().as_encoded_bytes());
    digest.update(b"\0");
    digest.update(branch.unwrap_or("").as_bytes());
    format!("{:x}", digest.finalize())
}

/// Client environment the build must not let an argument name override, plus names
/// the client itself interprets (proxies would redirect the client's own traffic).
fn reserved_argument(name: &str) -> bool {
    const EXACT: [&str; 6] = ["PATH", "HOME", "LANG", "TMPDIR", "USER", "SHELL"];
    const PREFIXES: [&str; 3] = ["DOCKER_", "BUILDX_", "BUILDKIT_"];
    let upper = name.to_ascii_uppercase();
    EXACT.contains(&upper.as_str())
        || PREFIXES.iter().any(|prefix| upper.starts_with(prefix))
        || upper.ends_with("_PROXY")
        || upper.starts_with("LC_")
        || upper.starts_with("GIT_")
        || upper.starts_with("SSH_")
}

fn valid_argument_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() <= 128
        && bytes
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

fn valid_branch(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn validate_request(request: &BuildRequest) -> Result<(), CandidateError> {
    if request.version != 1 {
        return Err(invalid("Unsupported build request version."));
    }
    if !request.project_root.is_absolute() {
        return Err(invalid("The project root must be an absolute path."));
    }
    if request.branch.as_deref().is_some_and(|b| !valid_branch(b)) {
        return Err(invalid(
            "The branch selector must be a lowercase DNS label.",
        ));
    }
    if request
        .target
        .as_deref()
        .is_some_and(|t| !valid_identifier(t))
    {
        return Err(invalid("Invalid build target name."));
    }
    if request.args.len() > MAX_ARGS {
        return Err(refusal(
            "native_build_argument",
            "A native build accepts at most 64 arguments.",
        ));
    }
    let mut total = 0_usize;
    for (name, value) in &request.args {
        if !valid_argument_name(name) {
            return Err(refusal(
                "native_build_argument",
                "Build argument names must match [A-Za-z_][A-Za-z0-9_]* and be at most 128 bytes.",
            ));
        }
        if reserved_argument(name) {
            return Err(refusal(
                "native_build_argument",
                "Build argument names may not set the build client's own environment (PATH, HOME, DOCKER_*, BUILDX_*, BUILDKIT_*, proxies, locale, Git or SSH settings).",
            ));
        }
        if value.bytes().any(|b| b == 0) {
            return Err(refusal(
                "native_build_argument",
                "Build argument values may not contain NUL bytes.",
            ));
        }
        total += name.len() + value.len();
    }
    if total > MAX_ARG_BYTES {
        return Err(refusal(
            "native_build_argument",
            "Build arguments exceed 64 KiB in total.",
        ));
    }
    let timeout = request.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECONDS);
    if timeout == 0 || timeout > MAX_TIMEOUT_SECONDS {
        return Err(invalid(
            "The build timeout must be between 1 and 7200 seconds.",
        ));
    }
    Ok(())
}

/// Read one optional bounded regular file without following a final symlink.
fn read_bounded_file(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, CandidateError> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(refusal(
                "native_build_source",
                "A build input is a symlink or cannot be opened.",
            ));
        }
    };
    let metadata = file.metadata().map_err(state::io)?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > limit {
        return Err(refusal(
            "native_build_source",
            "Build inputs must be singly linked regular files within their size limits.",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(state::io)?;
    if bytes.len() as u64 > limit {
        return Err(refusal(
            "native_build_source",
            "A build input grew beyond its size limit.",
        ));
    }
    Ok(Some(bytes))
}

/// The ignore files BuildKit applies to this context: a Dockerfile-specific
/// `<Dockerfile>.dockerignore` wins over the context's `.dockerignore`.
fn ignore_digests(context: &Path, dockerfile: &Path) -> Result<Value, CandidateError> {
    let mut specific = dockerfile.as_os_str().to_owned();
    specific.push(".dockerignore");
    let digest = |path: &Path| -> Result<Value, CandidateError> {
        Ok(read_bounded_file(path, MAX_IGNORE_BYTES)?
            .map_or(Value::Null, |bytes| Value::String(sha256_hex(&bytes))))
    };
    Ok(serde_json::json!({
        "context": digest(&context.join(".dockerignore"))?,
        "dockerfile": digest(Path::new(&specific))?,
    }))
}

/// Validate the request, resolve paths inside the project without following symlinks,
/// read and scan the Dockerfile and derive the build key. Pure local reads.
pub(super) fn prepare(request: BuildRequest) -> Result<Inputs, CandidateError> {
    validate_request(&request)?;
    let root = fs::canonicalize(&request.project_root).map_err(|_| {
        refusal(
            "native_build_source",
            "The project root does not exist or cannot be inspected.",
        )
    })?;
    if root != request.project_root || !root.is_dir() {
        return Err(refusal(
            "native_build_source",
            "The project root must be an exact canonical directory.",
        ));
    }
    let context = crate::project::resolve_source(&root, &root, &request.context, false)?;
    if !fs::symlink_metadata(&context).is_ok_and(|m| m.is_dir()) {
        return Err(refusal(
            "native_build_source",
            "The build context must be an existing project directory.",
        ));
    }
    let dockerfile = crate::project::resolve_source(&root, &context, &request.dockerfile, false)?;
    let bytes = read_bounded_file(&dockerfile, build_scan::MAX_DOCKERFILE_BYTES as u64)?
        .ok_or_else(|| {
            refusal(
                "native_build_source",
                "The Dockerfile must be an existing regular project file.",
            )
        })?;
    let scan = build_scan::scan(&build_scan::ScanRequest {
        dockerfile: &bytes,
        target: request.target.as_deref(),
        args: &request.args,
    })?;
    let namespace = namespace(&root, request.branch.as_deref());
    let relative = |path: &Path, base: &Path| -> String {
        path.strip_prefix(base)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let salted_args: BTreeMap<&str, String> = request
        .args
        .iter()
        .map(|(name, value)| {
            let mut digest = Sha256::new();
            digest.update(namespace.as_bytes());
            digest.update(b"\0");
            digest.update(name.as_bytes());
            digest.update(b"\0");
            digest.update(value.as_bytes());
            (name.as_str(), format!("{:x}", digest.finalize()))
        })
        .collect();
    let key_input = serde_json::json!({
        "v": 1,
        "namespace": namespace,
        "context": relative(&context, &root),
        "dockerfile": relative(&dockerfile, &context),
        "dockerfile_sha256": sha256_hex(&bytes),
        "dockerignore": ignore_digests(&context, &dockerfile)?,
        "target": request.target,
        "args": salted_args,
        "platform": "linux/arm64",
        "builder": {"buildx": artifact::BUILDER_VERSION, "engine": artifact::ENGINE_VERSION},
    });
    let key = sha256_hex(
        &serde_json::to_vec(&key_input).map_err(|_| invalid("Cannot encode the build key."))?,
    );
    Ok(Inputs {
        namespace,
        key,
        context,
        dockerfile,
        target: request.target,
        args: request.args,
        images: scan.images,
        policy: request.policy,
        timeout: Duration::from_secs(request.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECONDS)),
    })
}

fn builds_root(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/image-builds")
}

/// A cooperative `flock` on a private lock file, shared or exclusive, never blocking.
struct Flock(File);
impl Flock {
    fn open(path: &Path) -> Result<File, CandidateError> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(state::io)?;
        let metadata = file.metadata().map_err(state::io)?;
        // SAFETY: geteuid has no preconditions.
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(refusal("foreign_state", "Unsafe image build lock."));
        }
        Ok(file)
    }
    fn try_lock(file: File, operation: libc::c_int) -> Result<Option<Self>, CandidateError> {
        // SAFETY: `file` is a live owned descriptor; flock retains no pointers.
        if unsafe { libc::flock(file.as_raw_fd(), operation | libc::LOCK_NB) } == 0 {
            return Ok(Some(Self(file)));
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
            Ok(None)
        } else {
            Err(state::io(error))
        }
    }
}
impl Drop for Flock {
    fn drop(&mut self) {
        // SAFETY: the descriptor is live until this value drops.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

/// Refuse to stop the engine while a build operation is admitted. The caller holds the
/// provider lease: a build takes its shared fence only under that lease, so a build
/// cannot start between this check and the caller's effect.
pub(super) fn require_no_active_build(candidate: &Candidate) -> Result<(), CandidateError> {
    let path = builds_root(candidate).join("active.lock");
    if !path.try_exists().map_err(state::io)? {
        return Ok(());
    }
    match Flock::try_lock(Flock::open(&path)?, libc::LOCK_EX)? {
        Some(_probe) => Ok(()),
        None => Err(refusal(
            "provider_busy",
            "A native image build is running; let it finish or cancel it, then stop the runtime.",
        )),
    }
}

fn read_receipt(path: &Path) -> Result<Option<Receipt>, CandidateError> {
    if !path.try_exists().map_err(state::io)? {
        return Ok(None);
    }
    state::read_bounded(path, MAX_RECEIPT_BYTES).map(Some)
}

fn label_violation(config_labels: &Value, expected: &BTreeMap<&'static str, String>) -> bool {
    let labels = match config_labels {
        Value::Null => return true,
        Value::Object(labels) => labels,
        _ => return true,
    };
    for (key, value) in expected {
        if labels.get(*key).and_then(Value::as_str) != Some(value.as_str()) {
            return true;
        }
    }
    labels.keys().any(|key| {
        RESERVED_LABEL_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
            && !expected.contains_key(key.as_str())
    })
}

/// Whether an inspected image is exactly the one this build key owns.
fn owned_image(
    inspected: &Value,
    id: &str,
    expected: &BTreeMap<&'static str, String>,
) -> Result<(), CandidateError> {
    if inspected["Id"] != id || inspected["Architecture"] != "arm64" || inspected["Os"] != "linux" {
        return Err(refusal(
            "native_build_image",
            "The built image identity or platform differs from the build result.",
        ));
    }
    if label_violation(&inspected["Config"]["Labels"], expected) {
        return Err(refusal(
            "native_build_reserved_label",
            "The built image lacks its ownership labels or carries other reserved ownership labels (com.docker.compose.*, io.hack-local.*, io.hack.native-config.*, io.hack.native-file.*, io.hack.storage-witness.*).",
        ));
    }
    match &inspected["Config"]["Volumes"] {
        Value::Null => Ok(()),
        Value::Object(volumes) if volumes.is_empty() => Ok(()),
        _ => Err(refusal(
            "native_build_image_volumes",
            "The built image declares VOLUME paths; native services refuse implicit image volumes.",
        )),
    }
}

/// Run one build operation end to end. See the module documentation for the protocol.
/// `canceled` reports a pending cancellation request; it is checked before each
/// unleased step and while the client runs.
pub(super) fn run<P: BuildPool>(
    candidate: &Candidate,
    pool: &P,
    inputs: &Inputs,
    canceled: &dyn Fn() -> bool,
) -> Result<BuildOutcome, CandidateError> {
    let canceled_early = || {
        refusal(
            "native_build_canceled",
            "The image build was canceled before the build client started; no image was adopted.",
        )
    };
    let root = builds_root(candidate);
    state::private_directory(&root)?;
    let directory = root.join(&inputs.namespace);
    let receipt_path = directory.join(format!("{}.json", inputs.key));
    // Step 1, under the lease: fence, key lock and the reuse decision.
    let (lease, identity) = pool.lease()?;
    let _fence = Flock::try_lock(Flock::open(&root.join("active.lock"))?, libc::LOCK_SH)?
        .ok_or_else(|| {
            refusal(
                "provider_busy",
                "The runtime is stopping; no build was admitted.",
            )
        })?;
    state::private_directory(&directory)?;
    let _key_lock = Flock::try_lock(
        Flock::open(&directory.join(format!("{}.lock", inputs.key)))?,
        libc::LOCK_EX,
    )?
    .ok_or_else(|| {
        refusal(
            "native_build_busy",
            "Another operation is building this image; wait for it and retry.",
        )
    })?;
    let expected = labels(inputs, &identity);
    let previous = read_receipt(&receipt_path)?;
    if let Some(previous) = &previous {
        if previous.version != 1
            || previous.namespace != inputs.namespace
            || previous.build_key != inputs.key
        {
            return Err(refusal(
                "native_build_receipt",
                "A build receipt does not match its path; no image was adopted or replaced.",
            ));
        }
        if inputs.policy == Policy::Missing
            && previous.phase == Phase::ContentIdVerified
            && previous.checkout == candidate.checkout
            && previous.provider_incarnation == identity.incarnation
            && previous.engine_id == identity.engine_id
        {
            if let Some(id) = previous.image_id.as_deref().filter(|id| image_id(id)) {
                if let Some(inspected) = pool.inspect(&lease, id)? {
                    if owned_image(&inspected, id, &expected).is_ok() {
                        if previous.provider_boot_id != identity.boot_id {
                            let mut current = previous.clone();
                            current.provider_boot_id = identity.boot_id.clone();
                            state::write(&receipt_path, &current)?;
                        }
                        return Ok(BuildOutcome {
                            image_id: id.to_owned(),
                            build_key: inputs.key.clone(),
                            tag: inputs.tag(),
                            reused: true,
                            base_pins: previous.base_pins.clone(),
                        });
                    }
                }
            }
        }
        if previous.phase == Phase::Building {
            // The key lock proves no live holder: that attempt died mid-build.
            let mut dead = previous.clone();
            dead.phase = Phase::Indeterminate;
            state::write(&receipt_path, &dead)?;
        }
    }
    drop(lease);

    // Step 2, unleased: resolve every base image to a pinned manifest.
    let mut pins = BTreeMap::new();
    for base in &inputs.images {
        if canceled() {
            return Err(canceled_early());
        }
        let resolved = pool.resolve(base)?;
        if !image_id(&resolved.source_digest)
            || !resolved
                .pinned_reference
                .ends_with(&format!("@{}", resolved.source_digest))
        {
            return Err(refusal(
                "native_build_base_image",
                "A build base image did not resolve to a pinned manifest.",
            ));
        }
        pins.insert(base.context_name.clone(), resolved.pinned_reference);
    }
    let builder = pool.builder()?;
    if canceled() {
        return Err(canceled_early());
    }

    // Step 3, under the lease: same pool, then record the attempt.
    let (lease, current) = pool.lease()?;
    if current != identity {
        return Err(refusal(
            "runtime_changed",
            "The runtime changed before the build started; no build was run.",
        ));
    }
    let mut receipt = Receipt {
        version: 1,
        checkout: candidate.checkout.clone(),
        namespace: inputs.namespace.clone(),
        build_key: inputs.key.clone(),
        provider_incarnation: identity.incarnation.clone(),
        provider_boot_id: identity.boot_id.clone(),
        engine_id: identity.engine_id.clone(),
        phase: Phase::Building,
        image_id: None,
        base_pins: pins.clone(),
    };
    state::write(&receipt_path, &receipt)?;
    drop(lease);

    // Step 4, unleased: run the client in its own process group.
    let scratch = directory.join(format!("{}.client", inputs.key));
    state::private_directory(&scratch)?;
    let metadata = scratch.join("metadata.json");
    match fs::remove_file(&metadata) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(state::io(error)),
    }
    let ended = supervise(
        command(
            &builder, &scratch, &metadata, inputs, &identity, &pins, &expected,
        )?,
        inputs.timeout,
        canceled,
    );
    let ended = match ended {
        Ok(ended) => ended,
        Err(error) => {
            receipt.phase = Phase::Indeterminate;
            state::write(&receipt_path, &receipt)?;
            return Err(error);
        }
    };
    match ended {
        Ended::Exited(true) => {}
        Ended::Exited(false) => {
            receipt.phase = Phase::Failed;
            state::write(&receipt_path, &receipt)?;
            return Err(refusal(
                "native_build_failed",
                "The image build failed; its output is shown above. No image was adopted.",
            ));
        }
        Ended::Canceled => {
            receipt.phase = Phase::Canceled;
            state::write(&receipt_path, &receipt)?;
            return Err(refusal(
                "native_build_canceled",
                "The image build was canceled; no image was adopted.",
            ));
        }
        Ended::TimedOut => {
            receipt.phase = Phase::Canceled;
            state::write(&receipt_path, &receipt)?;
            return Err(refusal(
                "native_build_timeout",
                "The image build exceeded its time budget and was stopped; no image was adopted.",
            ));
        }
    }

    // Step 5, under the lease: the same pool and engine, then adopt by content ID.
    let (lease, current) = pool.lease()?;
    if current != identity {
        receipt.phase = Phase::Indeterminate;
        state::write(&receipt_path, &receipt)?;
        return Err(refusal(
            "runtime_changed",
            "The runtime changed during the build; the result was not adopted.",
        ));
    }
    let adopted = built_image_id(&metadata).and_then(|id| {
        let inspected = pool.inspect(&lease, &id)?.ok_or_else(|| {
            refusal(
                "native_build_image",
                "The built image is absent from the engine.",
            )
        })?;
        owned_image(&inspected, &id, &expected)?;
        Ok(id)
    });
    let id = match adopted {
        Ok(id) => id,
        Err(error) => {
            // A refused or missing result is a failed build; an engine or transport
            // error leaves the outcome unknown.
            receipt.phase = if error.code.starts_with("native_build_") {
                Phase::Failed
            } else {
                Phase::Indeterminate
            };
            state::write(&receipt_path, &receipt)?;
            return Err(error);
        }
    };
    receipt.phase = Phase::ContentIdVerified;
    receipt.image_id = Some(id.clone());
    state::write(&receipt_path, &receipt)?;
    drop(lease);
    Ok(BuildOutcome {
        image_id: id,
        build_key: inputs.key.clone(),
        tag: inputs.tag(),
        reused: false,
        base_pins: pins,
    })
}

/// The image config digest the client reports for the built image.
fn built_image_id(metadata: &Path) -> Result<String, CandidateError> {
    let bytes = read_bounded_file(metadata, MAX_METADATA_BYTES)?.ok_or_else(|| {
        refusal(
            "native_build_image",
            "The build client reported no image metadata.",
        )
    })?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        refusal(
            "native_build_image",
            "The build client wrote malformed image metadata.",
        )
    })?;
    let id = value["containerimage.config.digest"]
        .as_str()
        .filter(|id| image_id(id))
        .ok_or_else(|| {
            refusal(
                "native_build_image",
                "The build metadata has no image content ID.",
            )
        })?;
    Ok(id.to_owned())
}

/// The client command: argv carries only paths, names and non-secret labels; argument
/// values reach the client through its environment.
fn command(
    builder: &Path,
    scratch: &Path,
    metadata: &Path,
    inputs: &Inputs,
    identity: &PoolIdentity,
    pins: &BTreeMap<String, String>,
    labels: &BTreeMap<&'static str, String>,
) -> Result<std::process::Command, CandidateError> {
    let config = scratch.join("docker-config");
    let buildx = scratch.join("buildx");
    state::private_directory(&config)?;
    state::private_directory(&buildx)?;
    let mut command = super::process::clean_command(builder);
    command
        .current_dir(scratch)
        .env("HOME", scratch)
        .env("TMPDIR", scratch)
        .env(
            "DOCKER_HOST",
            format!("unix://{}", identity.socket.display()),
        )
        // An empty private client configuration: no contexts, credential helpers or
        // proxies from the user's Docker setup.
        .env("DOCKER_CONFIG", &config)
        .env("BUILDX_CONFIG", &buildx)
        .env("BUILDX_NO_DEFAULT_ATTESTATIONS", "1")
        .env("DOCKER_CLI_HINTS", "false")
        .args(["build", "--progress=plain", "--platform", "linux/arm64"])
        .args(["--provenance=false", "--sbom=false", "--load"])
        .arg("--file")
        .arg(&inputs.dockerfile)
        .arg("--metadata-file")
        .arg(metadata)
        .args(["--tag", &inputs.tag()]);
    if let Some(target) = &inputs.target {
        command.args(["--target", target]);
    }
    for (name, value) in &inputs.args {
        command.args(["--build-arg", name]).env(name, value);
    }
    for (name, reference) in pins {
        command
            .arg("--build-context")
            .arg(format!("{name}=docker-image://{reference}"));
    }
    for (name, value) in labels {
        command.arg("--label").arg(format!("{name}={value}"));
    }
    command
        .arg(&inputs.context)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .process_group(0);
    Ok(command)
}

#[derive(Debug, Eq, PartialEq)]
enum Ended {
    Exited(bool),
    Canceled,
    TimedOut,
}

static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);
extern "C" fn request_cancel(_: libc::c_int) {
    CANCEL_REQUESTED.store(true, Ordering::Release);
}

/// SIGINT, SIGTERM and SIGHUP request cancellation for the whole operation; the
/// previous dispositions return when this guard drops.
struct CancelSignals(Vec<(libc::c_int, libc::sigaction)>);
impl CancelSignals {
    fn install() -> Result<Self, CandidateError> {
        CANCEL_REQUESTED.store(false, Ordering::Release);
        let mut previous_actions = Vec::new();
        for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
            // SAFETY: sigaction structs are plain C storage, zero-initialized before use.
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            // SAFETY: as above; the kernel fills it with the previous disposition.
            let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = request_cancel as *const () as usize;
            // SAFETY: valid writable mask storage.
            unsafe { libc::sigemptyset(&mut action.sa_mask) };
            // SAFETY: both pointers reference live storage for the duration of the call.
            if unsafe { libc::sigaction(signal, &action, &mut previous) } != 0 {
                return Err(state::io(std::io::Error::last_os_error()));
            }
            previous_actions.push((signal, previous));
        }
        Ok(Self(previous_actions))
    }
}
impl Drop for CancelSignals {
    fn drop(&mut self) {
        for (signal, previous) in &self.0 {
            // SAFETY: restores a disposition the kernel returned for this signal.
            unsafe {
                libc::sigaction(*signal, previous, std::ptr::null_mut());
            }
        }
    }
}

/// Spawn the client and wait for it, honoring cancellation and the time budget. On
/// either, the whole process group gets SIGTERM, then SIGKILL after a grace period.
/// The group is signaled only while its leader is unreaped, so its ID is still ours.
fn supervise(
    mut command: std::process::Command,
    timeout: Duration,
    canceled: &dyn Fn() -> bool,
) -> Result<Ended, CandidateError> {
    let mut child = command.spawn().map_err(|_| {
        refusal(
            "native_build_client",
            "The pinned build client could not be started.",
        )
    })?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().map_err(state::io)? {
            return Ok(Ended::Exited(status.success()));
        }
        let cancel = canceled();
        if cancel || Instant::now() >= deadline {
            stop_group(&mut child)?;
            return Ok(if cancel {
                Ended::Canceled
            } else {
                Ended::TimedOut
            });
        }
        std::thread::sleep(POLL);
    }
}

fn stop_group(child: &mut Child) -> Result<(), CandidateError> {
    let group = child.id() as libc::pid_t;
    // SAFETY: the leader is unreaped, so this process group ID cannot be reused yet.
    unsafe { libc::killpg(group, libc::SIGTERM) };
    let grace = Instant::now() + CANCEL_GRACE;
    while Instant::now() < grace {
        if child.try_wait().map_err(state::io)?.is_some() {
            return Ok(());
        }
        std::thread::sleep(POLL);
    }
    // SAFETY: still unreaped (checked above), so the group ID is still ours.
    unsafe { libc::killpg(group, libc::SIGKILL) };
    child.wait().map_err(state::io)?;
    Ok(())
}

/// The live pool: the candidate's running provider and its pinned builder.
struct LivePool<'a> {
    candidate: &'a Candidate,
}

#[cfg(target_os = "macos")]
fn connect(candidate: &Candidate) -> Result<super::engine::Engine<'_>, CandidateError> {
    super::engine::Engine::connect_until(candidate, Instant::now() + LEASE_WAIT, || false)
}
#[cfg(not(target_os = "macos"))]
fn connect(candidate: &Candidate) -> Result<super::engine::Engine<'_>, CandidateError> {
    let _ = LEASE_WAIT;
    super::engine::Engine::connect(candidate)
}

/// Require the isolated build bridge this boot set up (guest-daemon.sh and
/// guest-build-network.sh). A pool started by an older Hack has neither; restarting the
/// runtime is the only remedy, and nothing here restarts the engine.
fn verify_build_network(engine: &super::engine::Engine<'_>) -> Result<(), CandidateError> {
    if matches!(
        engine.guest().network_intent(),
        super::NetworkIntent::Isolated
    ) {
        return Err(refusal(
            "native_build_isolated",
            "Native image builds need network egress; this runtime was started isolated.",
        ));
    }
    let restart = || {
        refusal(
            "native_build_runtime_restart",
            "This native runtime has no isolated build network; stop the native runtime and run `hack up` again.",
        )
    };
    let bridge = match engine.request(reqwest::Method::GET, "/v1.53/networks/bridge", None) {
        Ok(bridge) => bridge,
        Err(error) if error.code == "engine_not_found" => return Err(restart()),
        Err(error) => return Err(error),
    };
    if bridge["IPAM"]["Config"][0]["Subnet"] != BUILD_NETWORK_SUBNET
        || bridge["Options"]["com.docker.network.bridge.enable_icc"] != "false"
    {
        return Err(restart());
    }
    let boot = engine.guest().boot_id().to_owned();
    let observed = engine
        .guest()
        .execute(
            &format!(
                "test \"$(cat /run/hack-local/build-network)\" = \"{BUILD_NETWORK_MARKER} $1\"\n\
                 iptables -C DOCKER-USER -i docker0 -j HACK-BUILD-FORWARD\n\
                 iptables -C INPUT -i docker0 -j HACK-BUILD-INPUT\n\
                 printf 'build-network-ready\\n'"
            ),
            &[&boot],
            None,
        )
        .map_err(|_| restart())?;
    if observed != "build-network-ready\n" {
        return Err(restart());
    }
    Ok(())
}

impl<'a> BuildPool for LivePool<'a> {
    type Lease = super::engine::Engine<'a>;
    fn lease(&self) -> Result<(Self::Lease, PoolIdentity), CandidateError> {
        let engine = connect(self.candidate)?;
        verify_build_network(&engine)?;
        let info = engine.request(reqwest::Method::GET, "/v1.53/info", None)?;
        let engine_id = info["ID"]
            .as_str()
            .filter(|id| {
                !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_graphic())
            })
            .ok_or_else(|| refusal("engine_protocol", "The engine reported no usable identity."))?
            .to_owned();
        let identity = PoolIdentity {
            incarnation: engine.guest().incarnation().to_owned(),
            boot_id: engine.guest().boot_id().to_owned(),
            engine_id,
            socket: engine.guest().engine_socket()?,
        };
        Ok((engine, identity))
    }
    fn inspect(&self, lease: &Self::Lease, image: &str) -> Result<Option<Value>, CandidateError> {
        match lease.request(
            reqwest::Method::GET,
            &format!("/v1.53/images/{image}/json"),
            None,
        ) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.code == "engine_not_found" => Ok(None),
            Err(error) => Err(error),
        }
    }
    fn resolve(&self, base: &BaseImage) -> Result<BuildBase, CandidateError> {
        registry_image::resolve_build_base(&base.reference)
    }
    fn builder(&self) -> Result<PathBuf, CandidateError> {
        artifact::verify_builder(self.candidate)?;
        Ok(artifact::builder_executable(self.candidate))
    }
}

/// `runtime build-image --request <private-file>`: build or reuse one native image.
pub fn build_image(candidate: &Candidate, request: &Path) -> Result<BuildOutcome, CandidateError> {
    let request: BuildRequest = state::read_bounded(request, MAX_REQUEST_BYTES)?;
    let inputs = prepare(request)?;
    let _signals = CancelSignals::install()?;
    run(candidate, &LivePool { candidate }, &inputs, &|| {
        CANCEL_REQUESTED.load(Ordering::Acquire)
    })
}
