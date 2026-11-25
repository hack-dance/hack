//! Native Compose `build:` images: `runtime build-image`.
//!
//! One operation builds one image for one build key inside the guest engine, through
//! the pinned host BuildKit client (`docker-buildx`, docker driver) talking to the
//! engine's verified forwarded socket through a private relay ([`client_relay`]) that
//! keeps the provider's socket forwarding out of a known busy loop. The built image
//! lands in the guest image store,
//! where graph admission already looks, and the caller pins the service to the content
//! ID it returns, so review, receipts and restore treat it like a pulled image.
//!
//! Authority and ownership:
//!
//! - The build key (version 2) binds the local inputs: namespace (project root and
//!   branch), context and Dockerfile paths, the Dockerfile and `.dockerignore` bytes,
//!   target, salted argument hashes, platform, the builder and engine versions, and a
//!   digest of every context entry the effective ignore rules let the build read
//!   (paths, kinds, permission bits, file contents and symlink targets; see
//!   [`context`]). Editing a copied file therefore builds a new image; editing an
//!   ignored one does not. A private stat cache keeps an unchanged context cheap to
//!   hash; [`context`] documents the change it can miss. Key version 1 lacked the
//!   context digest, so no receipt written under it can match a version-2 key.
//! - BuildKit builds from the bytes that were keyed: a build that runs the client first
//!   copies every recorded context entry into a private snapshot, hashing each file as
//!   it copies it, and points the client at the snapshot only ([`context::snapshot`]).
//!   A copy that differs from the key walk refuses `native_build_context_changed`
//!   before any receipt is written. Edits made while BuildKit runs cannot reach the
//!   image, so no context case remains in which the image holds bytes other than the
//!   keyed ones; a reused image's key misses only what the stat cache can miss (see
//!   [`context`]). Base images are pinned by digest.
//! - Resolve each base to a verified digest and a loaded config ID before output reuse.
//!   The build key includes those pins. BuildKit sees only attempt-owned local contexts.
//!   Base images with stored `ONBUILD` triggers refuse.
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
//! - Argument values never appear in argv, the client's environment, receipts or
//!   messages: the client runs `buildx bake` with a private mode-0600 definition file
//!   that carries them, removed after the run, and its environment is cleared to a
//!   fixed allowlist. Its output reaches the caller only through [`output::Filter`],
//!   which redacts every value and strips terminal control sequences, within fixed
//!   bounds.
//! - The client builds from a private copy of the Dockerfile and ignore bytes that were
//!   scanned and hashed, never from the project paths again.
//! - Every build runs under [`build_policy::build_document`] for its aliases, a BuildKit source
//!   policy the client sends with the solve: only the attempt's local base aliases resolve as
//!   images, and network sources (`ADD` URLs, git, image blobs) are denied, including
//!   ones a base image's stored `ONBUILD` triggers add.
//! - Build arguments are not secrets, as with Docker: an image records their values in
//!   its history, and resolved base references (which an argument may select) are
//!   reported in receipts and results. Hack still keeps values out of argv, the
//!   client's environment and its own messages, and redacts them from forwarded output
//!   as defense in depth. The caller refuses values equal to a managed secret.
//! - Nothing here removes images, prunes caches or adopts an image whose labels differ.
use super::{
    artifact, build_policy,
    build_scan::{self, BaseImage},
    registry_image::{self, BuildBase},
    state,
};
use crate::{Candidate, CandidateError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::fd::AsRawFd,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant, SystemTime},
};

pub(super) mod aliases;
mod client_relay;
mod context;
mod output;
pub mod reclaim;
pub mod retain;
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
/// Covers a receipt with the most base pins the scanner accepts at their longest
/// (about 32 KiB pretty-printed), so a receipt the build writes is always readable.
const MAX_RECEIPT_BYTES: u64 = 64 * 1024;
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_IGNORE_BYTES: u64 = 1024 * 1024;
const MAX_ARGS: usize = 64;
/// The build key document version; 2 added the context digest.
const KEY_VERSION: u32 = 2;
const MAX_ARG_BYTES: usize = 64 * 1024;
const GIB: u64 = 1024 * 1024 * 1024;
/// A cold build needs this much free guest storage, or twice the key's last verified
/// image size when that is larger. Admission refuses; it never deletes to make room.
const STORAGE_FLOOR: u64 = 6 * GIB;
/// BuildKit cache kept after each successful build. The cache in this engine is created
/// only by Hack builds and is regenerable; pruning never touches images or volumes.
pub(super) const CACHE_BUDGET: u64 = 4 * GIB;
/// Labels a Dockerfile (or a base image) must not set on an image Hack runs: the same
/// reserved ownership namespaces the frontend refuses on authored services.
const RESERVED_LABEL_PREFIXES: [&str; 5] = [
    "com.docker.compose.",
    "io.hack-local.",
    "io.hack.native-config.",
    "io.hack.native-file.",
    "io.hack.storage-witness.",
];

fn refusal(code: &'static str, message: impl Into<crate::ErrorMessage>) -> CandidateError {
    CandidateError::new(code, message)
}
fn invalid(message: impl Into<crate::ErrorMessage>) -> CandidateError {
    refusal("native_build_request", message)
}
fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", crate::Hex(Sha256::digest(bytes)))
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
    /// Always run BuildKit. Base selections still use their ordinary freshness policy.
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
    /// Literal build arguments. They are not secrets (an image records them in its
    /// history), but Hack keeps them out of argv and its own messages.
    #[serde(default)]
    pub args: BTreeMap<String, String>,
    pub policy: Policy,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
    #[serde(default)]
    pub image_policy_args: Vec<String>,
    #[serde(default)]
    pub image_tag_mode: super::image_policy::ImageTagMode,
    #[serde(default)]
    pub command_base_pins: BTreeMap<String, String>,
    #[serde(default)]
    pub share_command_base_pins: bool,
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub base_fallbacks: Vec<super::image_ensure::EnsuredTag>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub base_selections: BTreeMap<String, String>,
    pub reused_legacy_key: bool,
    /// Build cache bytes the post-build prune reclaimed; `None` when no prune ran or
    /// it failed (the build result stands either way).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_reclaimed_bytes: Option<u64>,
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
    /// Engine-reported size of the last verified image of this key, for the next cold
    /// build's admission. Attempts that verify no image carry it forward unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image_bytes: Option<u64>,
    base_pins: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    base_image_ids: BTreeSet<String>,
    /// The build declaration this key is a revision of (see [`Inputs::declaration`]).
    /// Receipts from before this field have none and are never reclaimed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    declaration: Option<String>,
    /// When this key last became the declaration's image in use: larger is more
    /// recent within its namespace (see [`next_sequence`]). Absent on old receipts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sequence: Option<u64>,
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
    fn try_lease(&self) -> Result<(Self::Lease, PoolIdentity), CandidateError> {
        self.lease()
    }
    fn observe_build(&self, image: &str) -> Result<(PoolIdentity, Option<Value>), CandidateError> {
        let (lease, identity) = self.try_lease()?;
        Ok((identity, self.inspect(&lease, image)?))
    }
    fn cleanup_lease(&self) -> Result<(Self::Lease, PoolIdentity), CandidateError> {
        self.lease()
    }
    /// Inspect one image by content ID or tag; `None` when the engine reports it absent.
    fn inspect(&self, lease: &Self::Lease, image: &str) -> Result<Option<Value>, CandidateError>;
    fn tag_base(&self, lease: &Self::Lease, id: &str, tag: &str) -> Result<(), CandidateError>;
    fn untag_base(&self, lease: &Self::Lease, tag: &str) -> Result<(), CandidateError>;
    /// The verified builder executable.
    fn builder(&self) -> Result<PathBuf, CandidateError>;
    /// Where the client's filtered output goes.
    fn output(&self) -> Box<dyn Write + Send>;
    /// Free bytes on the guest storage disk that holds images and build cache.
    fn storage_available(&self, lease: &Self::Lease) -> Result<u64, CandidateError>;
    /// Prune BuildKit cache down to `max_used` bytes; returns the bytes reclaimed.
    fn prune_cache(&self, lease: &Self::Lease, max_used: u64) -> Result<u64, CandidateError>;
}

/// Free storage a cold build of a key requires.
pub(super) fn storage_required(previous_image_bytes: Option<u64>) -> u64 {
    previous_image_bytes
        .map_or(0, |bytes| bytes.saturating_mul(2))
        .max(STORAGE_FLOOR)
}

/// Validated local inputs and the build key derived from them.
///
/// The Dockerfile and its effective ignore file are held as the exact bytes that were
/// scanned and hashed: the client builds from a private copy of them, never from the
/// mutable project paths, so a file edited while bases resolve cannot reach BuildKit.
#[derive(Debug)]
pub(super) struct Inputs {
    namespace: String,
    key: String,
    context: PathBuf,
    dockerfile: Vec<u8>,
    /// The ignore rules BuildKit applies: the Dockerfile-specific file if present, else
    /// the context's `.dockerignore`, else empty (no exclusions).
    ignore: Vec<u8>,
    target: Option<String>,
    args: BTreeMap<String, String>,
    images: Vec<BaseImage>,
    tag_mode: super::image_policy::ImageTagMode,
    policy: Policy,
    timeout: Duration,
    /// Every included context entry the key walk hashed; a build copies exactly these
    /// into its private snapshot.
    recorded: Vec<context::Entry>,
    /// The build declaration this key revises: namespace, context, Dockerfile and
    /// target, so successive edits of one service's build share it while its key
    /// changes. Reclamation keeps a declaration's current and previous images only.
    declaration: String,
    /// The document hashed into `key`.
    #[cfg(test)]
    key_input: Value,
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
    format!("{:x}", crate::Hex(digest.finalize()))
}

/// Build-argument names BuildKit or buildx interpret themselves rather than passing to
/// the Dockerfile: `BUILDKIT_*` (for example `BUILDKIT_SYNTAX` selects a frontend
/// image), `BUILDX_*` and `SOURCE_DATE_EPOCH`. Any case refuses. Other names, including
/// ones a process environment would interpret (`PATH`, `LD_*`, `GO*`, proxies), are
/// ordinary Dockerfile arguments here: values travel only in the private bake
/// definition and never enter the client's environment.
fn reserved_argument(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.starts_with("BUILDKIT_") || upper.starts_with("BUILDX_") || upper == "SOURCE_DATE_EPOCH"
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
                "Build argument names may not be ones BuildKit or buildx interpret themselves (BUILDKIT_*, BUILDX_*, SOURCE_DATE_EPOCH).",
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
struct IgnoreFiles {
    context: Option<Vec<u8>>,
    dockerfile: Option<Vec<u8>>,
}
impl IgnoreFiles {
    fn read(
        project: &context::ProjectRoot,
        context: &Path,
        dockerfile: &Path,
    ) -> Result<Self, CandidateError> {
        let mut specific = dockerfile.as_os_str().to_owned();
        specific.push(".dockerignore");
        Ok(Self {
            context: project.read(&context.join(".dockerignore"), MAX_IGNORE_BYTES)?,
            dockerfile: project.read(Path::new(&specific), MAX_IGNORE_BYTES)?,
        })
    }
    fn digests(&self) -> Value {
        let digest = |bytes: &Option<Vec<u8>>| {
            bytes
                .as_deref()
                .map_or(Value::Null, |bytes| Value::String(sha256_hex(bytes)))
        };
        serde_json::json!({
            "context": digest(&self.context),
            "dockerfile": digest(&self.dockerfile),
        })
    }
    /// The rules in force. An empty file excludes nothing, exactly like an absent one.
    fn effective(self) -> Vec<u8> {
        self.dockerfile.or(self.context).unwrap_or_default()
    }
}

struct Scanned {
    root: PathBuf,
    context: PathBuf,
    dockerfile: PathBuf,
    project: context::ProjectRoot,
    bytes: Vec<u8>,
    scan: build_scan::DockerfileScan,
}

fn scan_request(request: &BuildRequest) -> Result<Scanned, CandidateError> {
    validate_request(request)?;
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
    let private = context::private::PrivateFiles::new()?;
    if private.excludes(&context)? {
        return Err(refusal(
            "native_build_source",
            "The build context is Hack's own machine-local directory, which is never sent to a build.",
        ));
    }
    let dockerfile = crate::project::resolve_source(&root, &context, &request.dockerfile, false)?;
    if private.excludes(&dockerfile)? {
        return Err(refusal(
            "native_build_source",
            "The Dockerfile is Hack's own machine-local file, which is never sent to a build.",
        ));
    }
    // Every input file is read through descriptors held from the project root down.
    let project = context::ProjectRoot::open(&root)?;
    let bytes = project
        .read(&dockerfile, build_scan::MAX_DOCKERFILE_BYTES as u64)?
        .ok_or_else(|| {
            refusal(
                "native_build_source",
                "The Dockerfile must be an existing regular project file.",
            )
        })?;
    let scan = build_scan::scan_with_context(
        &build_scan::ScanRequest {
            dockerfile: &bytes,
            target: request.target.as_deref(),
            args: &request.args,
        },
        &|source| private.copy_source(&context, source),
    )?;
    Ok(Scanned {
        root,
        context,
        dockerfile,
        project,
        bytes,
        scan,
    })
}

/// Read only the admitted Dockerfile and list external bases for a forced pull.
pub fn build_bases(request: &Path) -> Result<Vec<String>, CandidateError> {
    let request: BuildRequest = state::read_bounded(request, MAX_REQUEST_BYTES)?;
    Ok(scan_request(&request)?
        .scan
        .images
        .into_iter()
        .map(|base| base.reference.canonical())
        .collect())
}

/// Validate and fingerprint the complete build input without network access.
pub(super) fn prepare(request: BuildRequest, builds: &Path) -> Result<Inputs, CandidateError> {
    let Scanned {
        root,
        context,
        dockerfile,
        project,
        bytes,
        scan,
    } = scan_request(&request)?;
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
            (
                name.as_str(),
                format!("{:x}", crate::Hex(digest.finalize())),
            )
        })
        .collect();
    let ignore = IgnoreFiles::read(&project, &context, &dockerfile)?;
    let ignore_digests = ignore.digests();
    let ignore = ignore.effective();
    let cache = builds.join(&namespace).join(context::cache_name(&context));
    let context_digest = context::digest(
        &context,
        &ignore,
        Some(&cache),
        SystemTime::now(),
        context::Bounds::DEFAULT,
    )?;
    let key_input = serde_json::json!({
        "v": KEY_VERSION,
        "namespace": namespace,
        "context": relative(&context, &root),
        "dockerfile": relative(&dockerfile, &context),
        "dockerfile_sha256": sha256_hex(&bytes),
        "dockerignore": ignore_digests,
        "context_sha256": context_digest.digest,
        "target": request.target,
        "args": salted_args,
        "platform": "linux/arm64",
        "builder": {"buildx": artifact::BUILDER_VERSION, "engine": artifact::ENGINE_VERSION},
    });
    let key = sha256_hex(
        &serde_json::to_vec(&key_input).map_err(|_| invalid("Cannot encode the build key."))?,
    );
    let declaration = sha256_hex(
        &serde_json::to_vec(&serde_json::json!({
            "v": 1,
            "namespace": key_input["namespace"],
            "context": key_input["context"],
            "dockerfile": key_input["dockerfile"],
            "target": key_input["target"],
        }))
        .map_err(|_| invalid("Cannot encode the build declaration."))?,
    );
    Ok(Inputs {
        namespace,
        key,
        context,
        dockerfile: bytes,
        ignore,
        target: request.target,
        args: request.args,
        images: scan.images,
        tag_mode: request.image_tag_mode,
        policy: request.policy,
        timeout: Duration::from_secs(request.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECONDS)),
        recorded: context_digest.recorded,
        declaration,
        #[cfg(test)]
        key_input,
    })
}

fn builds_root(candidate: &Candidate) -> PathBuf {
    candidate.state_root.join("run/image-builds")
}

/// A cooperative `flock` on a private lock file, shared or exclusive, never blocking.
///
/// A `flock` belongs to the open file description, so a child that inherits the
/// descriptor holds the lock for as long as it keeps it open if this process is
/// killed before it drops the lock (see [`inherit_locks`]).
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
        // An orderly drop releases the lock for every holder of the description, so a
        // transient copy in another thread's forked child cannot keep it. Only a
        // process that dies without dropping (SIGKILL) leaves the lock with the
        // descriptors its build client inherited.
        // SAFETY: the descriptor is live until this value drops.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

pub(super) fn image_fence(
    candidate: &Candidate,
    mode: libc::c_int,
) -> Result<impl Drop + use<>, CandidateError> {
    let root = builds_root(candidate);
    state::private_directory(&root)?;
    Flock::try_lock(Flock::open(&root.join("active.lock"))?, mode)?.ok_or_else(|| {
        refusal(
            "provider_busy",
            "Image acquisition or reclamation is in progress; wait for it and retry.",
        )
    })
}

/// Take the shared fence before asking for the provider lease.
/// A staged background download yields to an admitted foreground operation.
pub(super) fn check_retention_idle(state_root: &Path) -> Result<(), CandidateError> {
    let _provider = state::Lock::acquire_existing(&state_root.join("run/smolvm"))?;
    let fence = Flock::open(&state_root.join("run/image-builds/active.lock"))?;
    Flock::try_lock(fence, libc::LOCK_EX)?
        .ok_or_else(|| refusal("provider_busy", "Background image retention deferred."))?;
    Ok(())
}

fn idle_retention_fence(candidate: &Candidate) -> Result<Flock, CandidateError> {
    let root = builds_root(candidate);
    state::private_directory(&root)?;
    let lock = Flock::try_lock(Flock::open(&root.join("active.lock"))?, libc::LOCK_EX)?
        .ok_or_else(|| refusal("provider_busy", "The image fence is in use."))?;
    // SAFETY: the descriptor remains owned by lock. The provider lease already
    // excludes mutating work across the flock conversion.
    if unsafe { libc::flock(lock.0.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) } != 0 {
        return Err(refusal("provider_busy", "The image fence is in use."));
    }
    Ok(lock)
}

pub(super) fn wait_for_image_fence(
    candidate: &Candidate,
    policy: &super::image_policy::ImagePolicy,
) -> Result<impl Drop + use<>, CandidateError> {
    let limit = Duration::from_secs(60);
    state::wait_for_image_lock(
        policy.image_wait(limit)?.min(limit),
        "image-reclaim",
        || image_fence(candidate, libc::LOCK_SH),
    )
}

/// Refuse to stop the engine while a build operation is admitted. The caller holds the
/// provider lease, which prevents further build admission while it stops the engine.
pub(super) fn require_no_active_build(candidate: &Candidate) -> Result<(), CandidateError> {
    let path = builds_root(candidate).join("active.lock");
    if !path.try_exists().map_err(state::io)? {
        return Ok(());
    }
    match Flock::try_lock(Flock::open(&path)?, libc::LOCK_EX)? {
        Some(_probe) => Ok(()),
        None => Err(refusal(
            "provider_busy",
            "A native image operation is running; let it finish or cancel it, then stop the runtime.",
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

fn reuse_verified(
    candidate: &Candidate,
    inputs: &Inputs,
    path: Option<&Path>,
    previous: &Receipt,
    observe: impl FnOnce(&str) -> Result<(PoolIdentity, Option<Value>), CandidateError>,
) -> Result<Option<BuildOutcome>, CandidateError> {
    if inputs.policy == Policy::Missing
        && previous.version == 1
        && previous.namespace == inputs.namespace
        && previous.build_key == inputs.key
        && previous.phase == Phase::ContentIdVerified
        && previous.checkout == candidate.checkout
        && let Some(id) = previous.image_id.as_deref().filter(|id| image_id(id))
    {
        let (identity, inspected) = observe(id)?;
        if previous.provider_incarnation != identity.incarnation
            || previous.engine_id != identity.engine_id
            || !inspected
                .is_some_and(|image| owned_image(&image, id, &labels(inputs, &identity)).is_ok())
        {
            return Ok(None);
        }
        if let Some(path) = path {
            let mut current = previous.clone();
            current.provider_boot_id = identity.boot_id.clone();
            current.declaration = Some(inputs.declaration.clone());
            current.sequence = path.parent().map(next_sequence);
            state::write(path, &current)?;
        }
        return Ok(Some(reused(inputs, id, &previous.base_pins)));
    }
    Ok(None)
}

fn reuse_receipt<P: BuildPool>(
    candidate: &Candidate,
    pool: &P,
    inputs: &Inputs,
    expected: Option<&BTreeMap<String, BuildBase>>,
) -> Result<Option<BuildOutcome>, CandidateError> {
    if inputs.policy != Policy::Missing {
        return Ok(None);
    }
    let directory = builds_root(candidate).join(&inputs.namespace);
    let path = directory.join(format!("{}.json", inputs.key));
    if !path.try_exists().map_err(state::io)? {
        return Ok(None);
    }
    let fence = match image_fence(candidate, libc::LOCK_SH) {
        Ok(fence) => Some(fence),
        Err(error) if error.code == "provider_busy" => None,
        Err(error) => return Err(error),
    };
    let _key = if fence.is_some() {
        let lock = Flock::open(&directory.join(format!("{}.lock", inputs.key)))?;
        let Some(lock) = Flock::try_lock(lock, libc::LOCK_EX)? else {
            return Ok(None);
        };
        Some(lock)
    } else {
        None
    };
    let Some(previous) = read_receipt(&path)? else {
        return Ok(None);
    };
    // Exclusive reclaim cannot remove its current or previous build images.
    // Observe those read-only and leave receipt order unchanged.
    if fence.is_none()
        && !previous.image_id.as_ref().is_some_and(|id| {
            reclaim::current_images(candidate).is_ok_and(|current| current.builds.contains_key(id))
        })
    {
        return Ok(None);
    }
    if let Some(expected) = expected
        && (expected.len() != previous.base_pins.len()
            || expected
                .iter()
                .any(|(name, base)| previous.base_pins.get(name) != Some(&base.pinned_reference)))
    {
        return Err(refusal(
            "native_build_receipt",
            "A build receipt has unexpected base pins.",
        ));
    }
    if path
        .with_extension("pending")
        .try_exists()
        .map_err(state::io)?
    {
        return Ok(None);
    }
    reuse_verified(
        candidate,
        inputs,
        fence.is_some().then_some(path.as_path()),
        &previous,
        |id| pool.observe_build(id),
    )
}

fn reuse_legacy<P: BuildPool>(
    candidate: &Candidate,
    pool: &P,
    inputs: &Inputs,
) -> Result<Option<BuildOutcome>, CandidateError> {
    let mut outcome = reuse_receipt(candidate, pool, inputs, None)?;
    if let Some(reused) = &mut outcome {
        for base in &inputs.images {
            let reference = base.reference.canonical();
            let Some(pin) = reused.base_pins.get(&base.context_name) else {
                return Ok(None);
            };
            let (canonical, _) = registry_image::pinned_syntax(pin)?;
            let matches = if reference.contains('@') {
                reference == canonical
            } else {
                reference.rsplit_once(':').is_some_and(|(repo, _)| {
                    canonical
                        .strip_prefix(repo)
                        .is_some_and(|suffix| suffix.starts_with('@'))
                })
            };
            if !matches || canonical != *pin {
                return Ok(None);
            }
            reused.base_selections.insert(reference, canonical);
        }
        reused.reused_legacy_key = true;
    }
    Ok(outcome)
}

fn run_with_bases<P: BuildPool>(
    candidate: &Candidate,
    pool: &P,
    inputs: &Inputs,
    canceled: &dyn Fn() -> bool,
    selected: &BTreeMap<String, BuildBase>,
    deadline: Instant,
) -> Result<BuildOutcome, CandidateError> {
    let canceled_early = || {
        refusal(
            "native_build_canceled",
            "The image build was canceled before the build client started; no image was adopted.",
        )
    };
    let expired_early = || {
        refusal(
            "native_build_timeout",
            "The image build exceeded its time budget before the build client started; no image was adopted.",
        )
    };
    let root = builds_root(candidate);
    state::private_directory(&root)?;
    let directory = root.join(&inputs.namespace);
    let receipt_path = directory.join(format!("{}.json", inputs.key));
    // Step 1, under the lease: fence, key lock and the reuse decision.
    let (lease, identity) = pool.lease()?;
    let fence = Flock::try_lock(Flock::open(&root.join("active.lock"))?, libc::LOCK_SH)?
        .ok_or_else(|| {
            refusal(
                "provider_busy",
                "The runtime is stopping; no build was admitted.",
            )
        })?;
    state::private_directory(&directory)?;
    let key_lock = Flock::try_lock(
        Flock::open(&directory.join(format!("{}.lock", inputs.key)))?,
        libc::LOCK_EX,
    )?
    .ok_or_else(|| {
        refusal(
            "native_build_busy",
            "Another operation is building this image; wait for it and retry.",
        )
    })?;
    // `state::write` publishes through `<key>.pending` and a rename. A process that
    // died between the two left that file; the key lock proves no writer is live, so
    // the leftover is discarded (the committed receipt, if any, is unaffected).
    match fs::remove_file(receipt_path.with_extension("pending")) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(state::io(error)),
    }
    let alias_path = directory.join(format!("{}.client/base-aliases.json", inputs.key));
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
        if let Some(outcome) =
            reuse_verified(candidate, inputs, Some(&receipt_path), previous, |id| {
                Ok((identity.clone(), pool.inspect(&lease, id)?))
            })?
        {
            // Recovery cannot invalidate the verified reuse decision.
            let _ = aliases::sweep(pool, &lease, &identity, &alias_path);
            return Ok(outcome);
        }
        if previous.phase == Phase::Building {
            // The key lock proves no live holder: that attempt died mid-build.
            let mut dead = previous.clone();
            dead.phase = Phase::Indeterminate;
            state::write(&receipt_path, &dead)?;
        }
    }
    aliases::sweep_stranded(&root, pool, &lease, &identity, &alias_path);
    aliases::sweep(pool, &lease, &identity, &alias_path)?;
    let previous_bytes = previous.as_ref().and_then(|receipt| receipt.image_bytes);
    drop(lease);
    // Snapshots other attempts in this namespace stranded when they were killed.
    remove_stranded_snapshots(&directory);

    let pins: BTreeMap<_, _> = selected
        .iter()
        .map(|(name, base)| (name.clone(), base.pinned_reference.clone()))
        .collect();
    let builder = pool.builder()?;
    if canceled() {
        return Err(canceled_early());
    }
    if Instant::now() >= deadline {
        return Err(expired_early());
    }
    // Copy exactly the keyed context bytes into a private snapshot, the only context
    // BuildKit is given. Unleased.
    let scratch = directory.join(format!("{}.client", inputs.key));
    state::private_directory(&scratch)?;
    let stop = context::snapshot::stop_check(canceled, deadline);
    let snapshot = match context::snapshot::Snapshot::create(
        &inputs.context,
        &scratch.join("snapshot"),
        &inputs.recorded,
        &stop,
    ) {
        Ok(Ok(snapshot)) => snapshot,
        Ok(Err(context::snapshot::Stopped::Canceled)) => return Err(canceled_early()),
        Ok(Err(context::snapshot::Stopped::Expired)) => return Err(expired_early()),
        Err(error) => {
            if error.code == "native_build_context_changed" {
                // The stat cache may hold the stale hash (its documented miss); drop
                // it so the next attempt reads every file.
                let _ = fs::remove_file(directory.join(context::cache_name(&inputs.context)));
            }
            return Err(error);
        }
    };

    // Step 3, under the lease: same pool, then record the attempt.
    let (lease, current) = pool.lease()?;
    if current != identity {
        return Err(refusal(
            "runtime_changed",
            "The runtime changed before the build started; no build was run.",
        ));
    }
    if pool.storage_available(&lease)? < storage_required(previous_bytes) {
        return Err(refusal(
            "native_build_storage",
            "The native runtime's storage disk has too little free space for this build (at least 6 GiB, or twice the last image of this build). Inspect it with `runtime guest-disk-usage` and remove unused images or data; nothing was deleted.",
        ));
    }
    let mut local = BTreeMap::new();
    for (name, base) in selected {
        let present = pool.inspect(&lease, &base.image_id)?.is_some_and(|image| {
            image["Id"] == base.image_id
                && image["Os"] == "linux"
                && image["Architecture"] == "arm64"
        });
        if present {
            local.insert(name.clone(), base.clone());
        } else if inputs.tag_mode == super::image_policy::ImageTagMode::Offline {
            return Err(refusal(
                "image_archive_offline_missing",
                "The verified build base is not loaded in the guest.",
            ));
        }
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
        // Failed, canceled or interrupted attempts keep the last verified size, so a
        // retry is admitted against it rather than the floor.
        image_bytes: previous_bytes,
        base_pins: pins.clone(),
        base_image_ids: selected
            .values()
            .map(|base| base.image_id.clone())
            .collect(),
        declaration: Some(inputs.declaration.clone()),
        // Kept from the last verified image of this key until this attempt verifies.
        sequence: previous.as_ref().and_then(|receipt| receipt.sequence),
    };
    state::write(&receipt_path, &receipt)?;
    let (aliases, local_pins) =
        aliases::Aliases::prepare(pool, &lease, &identity, alias_path, &local)?;
    let mut worker_pins = pins.clone();
    worker_pins.extend(local_pins);
    drop(lease);

    // Step 4, unleased: run the client in its own process group.
    let metadata = scratch.join("metadata.json");
    match fs::remove_file(&metadata) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(state::io(error)),
    }
    // Neither the definition (it carries argument values) nor the source policy
    // outlives the client run.
    let _definition = RemoveOnDrop(scratch.join("definition").join(BAKE_DEFINITION));
    let _policy = RemoveOnDrop(scratch.join("definition").join(SOURCE_POLICY));
    // The client reaches the engine only through the relay, which keeps the provider's
    // forwarded socket out of the state described in `client_relay`.
    let relay = client_relay::ClientRelay::start(&identity.socket)?;
    let mut client = command(
        &builder,
        &scratch,
        inputs,
        &snapshot.context(),
        relay.socket(),
        &worker_pins,
        &expected,
    )?;
    inherit_locks(&mut client, &[&fence, &key_lock]);
    let ended = supervise(
        client,
        deadline,
        canceled,
        output::Filter::new(inputs.args.values().map(String::as_str)),
        pool.output(),
    );
    // The client has exited or was stopped; wait for the guest to end its connections.
    relay.finish(client_relay::FINISH_GRACE);
    drop(aliases);
    let ended = match ended {
        Ok(ended) => ended,
        Err(error) => {
            receipt.phase = Phase::Indeterminate;
            state::write(&receipt_path, &receipt)?;
            return Err(error);
        }
    };
    match ended {
        Ended::Exited(true) => {
            // A cancellation or deadline reached while the client finished still wins.
            if canceled() || Instant::now() >= deadline {
                receipt.phase = Phase::Canceled;
                state::write(&receipt_path, &receipt)?;
                return Err(late_stop(canceled()));
            }
        }
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

    drop(snapshot);
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
        Ok((id, inspected["Size"].as_u64()))
    });
    let (id, image_bytes) = match adopted {
        Ok(adopted) => adopted,
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
    // The last point a cancellation or the deadline can still stop adoption.
    if canceled() || Instant::now() >= deadline {
        receipt.phase = Phase::Canceled;
        state::write(&receipt_path, &receipt)?;
        return Err(late_stop(canceled()));
    }
    receipt.phase = Phase::ContentIdVerified;
    receipt.image_id = Some(id.clone());
    receipt.sequence = Some(next_sequence(&directory));
    receipt.image_bytes = image_bytes.or(receipt.image_bytes);
    state::write(&receipt_path, &receipt)?;
    // The verified image is recorded first; a failed prune leaves only extra cache.
    let cache_reclaimed_bytes = pool.prune_cache(&lease, CACHE_BUDGET).ok();
    drop(lease);
    Ok(BuildOutcome {
        image_id: id,
        build_key: inputs.key.clone(),
        tag: inputs.tag(),
        reused: false,
        base_pins: pins,
        base_fallbacks: Vec::new(),
        base_selections: BTreeMap::new(),
        reused_legacy_key: false,
        cache_reclaimed_bytes,
    })
}

/// The refusal for a cancellation or deadline reached after the client ran.
fn late_stop(canceled: bool) -> CandidateError {
    if canceled {
        refusal(
            "native_build_canceled",
            "The image build was canceled; no image was adopted.",
        )
    } else {
        refusal(
            "native_build_timeout",
            "The image build exceeded its time budget and was stopped; no image was adopted.",
        )
    }
}

fn reused(inputs: &Inputs, id: &str, pins: &BTreeMap<String, String>) -> BuildOutcome {
    BuildOutcome {
        image_id: id.to_owned(),
        build_key: inputs.key.clone(),
        tag: inputs.tag(),
        reused: true,
        base_pins: pins.clone(),
        base_fallbacks: Vec::new(),
        base_selections: BTreeMap::new(),
        reused_legacy_key: false,
        cache_reclaimed_bytes: None,
    }
}

/// Remove the build snapshots in one namespace `directory` whose owning process is
/// provably gone. Checks run in this order, and the key lock is touched last:
///
/// 1. only `<key>.client/snapshot` trees, where `<key>.client` is a real private
///    directory of this user (never a symlink);
/// 2. the owner record proves the owner gone ([`context::snapshot::owner_gone`]);
/// 3. a non-blocking attempt on that key's lock succeeds (a live attempt, or a build
///    client that outlived its coordinator, holds it; the tree is then skipped);
/// 4. under the lock the owner is proved gone again, and only then the tree and its
///    record are removed; the lock is released right after.
///
/// So the probe can only coincide with an attempt of the same, already stranded key,
/// which then refuses `native_build_busy` and can retry. Failures leave the tree for
/// later. Returns how many trees were removed.
fn remove_stranded_snapshots(directory: &Path) -> usize {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let Some(key) = name
            .to_str()
            .and_then(|name| name.strip_suffix(".client"))
            .filter(|key| hex64(key))
        else {
            continue;
        };
        let scratch = entry.path();
        // SAFETY: geteuid has no preconditions.
        let ours = fs::symlink_metadata(&scratch).is_ok_and(|metadata| {
            metadata.is_dir()
                && metadata.uid() == unsafe { libc::geteuid() }
                && metadata.mode() & 0o077 == 0
        });
        let snapshot = scratch.join("snapshot");
        if !ours || !context::snapshot::owner_gone(&snapshot) {
            continue;
        }
        let lock = directory.join(format!("{key}.lock"));
        let Ok(Some(held)) =
            Flock::open(&lock).and_then(|file| Flock::try_lock(file, libc::LOCK_EX))
        else {
            continue;
        };
        if context::snapshot::owner_gone(&snapshot) && context::snapshot::remove_stranded(&snapshot)
        {
            removed += 1;
        }
        drop(held);
    }
    removed
}

/// The next reuse order for `directory` (one namespace): one more than any sequence its
/// receipts record. Unreadable receipts are skipped; they are never reclaimed anyway.
/// Two builds of different keys may race to the same number; reclamation then keeps
/// both (see `reclaim`).
fn next_sequence(directory: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(directory) else {
        return 1;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|path| state::read_bounded::<Receipt>(&path, MAX_RECEIPT_BYTES).ok())
        .filter_map(|receipt| receipt.sequence)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
}

/// Hold the shared build fence as an admitted build does, for the macOS-only lifecycle
/// test of the silent-guest stop.
#[cfg(all(test, target_os = "macos"))]
pub(super) fn hold_build_fence_for_test(candidate: &Candidate) -> impl Drop {
    let root = builds_root(candidate);
    state::private_directory(&root).unwrap();
    Flock::try_lock(
        Flock::open(&root.join("active.lock")).unwrap(),
        libc::LOCK_SH,
    )
    .unwrap()
    .unwrap()
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
    let id = value[BAKE_TARGET]["containerimage.config.digest"]
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

/// Write the scanned Dockerfile bytes and the effective ignore rules into a private
/// directory the client reads them from. The client applies `<Dockerfile>.dockerignore`
/// beside the Dockerfile in preference to the context's `.dockerignore`, so writing the
/// effective rules there (empty when there are none) keeps the hashed ignore semantics
/// without reading either project file again.
fn stage_dockerfile(scratch: &Path, inputs: &Inputs) -> Result<PathBuf, CandidateError> {
    let directory = scratch.join("dockerfile");
    state::private_directory(&directory)?;
    let dockerfile = directory.join("Dockerfile");
    write_private(&dockerfile, &inputs.dockerfile)?;
    write_private(&directory.join("Dockerfile.dockerignore"), &inputs.ignore)?;
    Ok(dockerfile)
}

/// Replace one private file with exactly these bytes, never following a symlink.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), CandidateError> {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(state::io(error)),
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(state::io)?;
    file.write_all(bytes).map_err(state::io)
}

/// The one bake target a build defines; its metadata is keyed by this name.
const BAKE_TARGET: &str = "build";
const BAKE_DEFINITION: &str = "definition.json";
/// The BuildKit source policy file beside the definition (see [`build_policy`]).
const SOURCE_POLICY: &str = "source-policy.json";

/// Removes one private file when dropped, on every exit path.
struct RemoveOnDrop(PathBuf);
impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Escape a string for the bake definition. Bake reads JSON definitions as HCL, where
/// `${...}` interpolates (variables, the environment, functions) and `%{...}` is a
/// template directive; `$${` and `%%{` are their literal forms. Every string in the
/// definition passes through here, so no project-supplied text is ever evaluated.
fn bake_literal(text: &str) -> String {
    text.replace("${", "$${").replace("%{", "%%{")
}

fn bake_strings(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(bake_literal(&text)),
        Value::Array(items) => Value::Array(items.into_iter().map(bake_strings).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (bake_literal(&key), bake_strings(value)))
                .collect(),
        ),
        other => other,
    }
}

/// The private bake definition: everything the build needs, argument values
/// included. It is written mode 0600 in the client's private scratch directory.
fn bake_definition(
    inputs: &Inputs,
    context: &Path,
    dockerfile: &Path,
    pins: &BTreeMap<String, String>,
    labels: &BTreeMap<&'static str, String>,
) -> Value {
    let contexts: BTreeMap<&str, String> = pins
        .iter()
        .map(|(name, reference)| (name.as_str(), format!("docker-image://{reference}")))
        .collect();
    let mut target = serde_json::json!({
        "context": context.to_string_lossy(),
        "dockerfile": dockerfile.to_string_lossy(),
        "args": inputs.args,
        "contexts": contexts,
        "labels": labels,
        "tags": [inputs.tag()],
        "platforms": ["linux/arm64"],
        "output": ["type=docker"],
    });
    if let Some(stage) = &inputs.target {
        target["target"] = Value::String(stage.clone());
    }
    bake_strings(serde_json::json!({"target": {BAKE_TARGET: target}}))
}

/// The client command: `buildx bake` with the private definition. Argv carries only
/// paths and fixed flags, and the environment is cleared to a fixed allowlist: argument
/// values travel only in the definition, never in argv or the client's environment.
/// The client reports to `<scratch>/metadata.json` and reads the context at `context`.
fn command(
    builder: &Path,
    scratch: &Path,
    inputs: &Inputs,
    context: &Path,
    engine: &Path,
    pins: &BTreeMap<String, String>,
    labels: &BTreeMap<&'static str, String>,
) -> Result<std::process::Command, CandidateError> {
    let config = scratch.join("docker-config");
    let buildx = scratch.join("buildx");
    let bake = scratch.join("definition");
    state::private_directory(&config)?;
    state::private_directory(&buildx)?;
    state::private_directory(&bake)?;
    let dockerfile = stage_dockerfile(scratch, inputs)?;
    let definition = bake.join(BAKE_DEFINITION);
    let metadata = scratch.join("metadata.json");
    let encoded = serde_json::to_vec(&bake_definition(inputs, context, &dockerfile, pins, labels))
        .map_err(|_| invalid("Cannot encode the build definition."))?;
    write_private(&definition, &encoded)?;
    // The policy allows exactly the private aliases the definition names as
    // contexts, and denies every other image and network source.
    let policy = bake.join(SOURCE_POLICY);
    let policy_bytes = serde_json::to_vec(&build_policy::build_document(
        pins.values().map(String::as_str),
    )?)
    .map_err(|_| invalid("Cannot encode the build source policy."))?;
    write_private(&policy, &policy_bytes)?;
    let mut command = super::process::clean_command(builder);
    command
        .current_dir(scratch)
        .env("HOME", scratch)
        .env("TMPDIR", scratch)
        .env("DOCKER_HOST", format!("unix://{}", engine.display()))
        // An empty private client configuration: no contexts, credential helpers or
        // proxies from the user's Docker setup.
        .env("DOCKER_CONFIG", &config)
        .env("BUILDX_CONFIG", &buildx)
        .env("BUILDX_NO_DEFAULT_ATTESTATIONS", "1")
        .env("DOCKER_CLI_HINTS", "false")
        // The client sends this policy with the solve, so BuildKit evaluates every
        // source of the build against it, including ones a base image's ONBUILD
        // triggers add.
        .env("EXPERIMENTAL_BUILDKIT_SOURCE_POLICY", &policy)
        .args([
            "bake",
            "--progress=plain",
            "--provenance=false",
            "--sbom=false",
        ])
        .arg("--file")
        .arg(&definition)
        .arg("--metadata-file")
        .arg(&metadata)
        // Bake requires explicit read access outside its working directory.
        .arg("--allow")
        .arg(format!("fs.read={}", context.display()))
        .arg("--allow")
        .arg(format!("fs.read={}", bake_parent(&dockerfile).display()))
        .arg(BAKE_TARGET)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // Output reaches the caller only through `output::Filter`.
        .stderr(Stdio::piped())
        .process_group(0);
    Ok(command)
}

fn bake_parent(path: &Path) -> &Path {
    path.parent().unwrap_or(path)
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

/// Let the client inherit the build fence and the key lock. If this process is killed
/// while the client runs, both stay held until the client and everything it leaves
/// running exit: `runtime down` keeps refusing, and a later attempt of the same key
/// refuses with `native_build_busy` instead of sharing the surviving client's attempt
/// files. An orderly return (after the client was reaped or stopped) releases them.
fn inherit_locks(command: &mut std::process::Command, locks: &[&Flock]) {
    let descriptors: Vec<libc::c_int> = locks.iter().map(|lock| lock.0.as_raw_fd()).collect();
    // SAFETY: runs in the forked child before exec; fcntl is async-signal-safe and the
    // descriptors are live (their owners outlive the spawn).
    unsafe {
        command.pre_exec(move || {
            for &fd in &descriptors {
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
}

/// Spawn the client and wait for it, honoring cancellation and the time budget. On
/// either, the whole process group gets SIGTERM, then SIGKILL after a grace period.
/// The group is signaled only while its leader is unreaped, so its ID is still ours.
/// The client's stderr passes through `filter` to `sink`; forwarding ends, bounded,
/// before this returns, so nothing from the client follows the operation's result.
fn supervise(
    mut command: std::process::Command,
    deadline: Instant,
    canceled: &dyn Fn() -> bool,
    filter: output::Filter,
    sink: Box<dyn Write + Send>,
) -> Result<Ended, CandidateError> {
    let mut child = super::process::spawn_child(&mut command).map_err(|_| {
        refusal(
            "native_build_client",
            "The pinned build client could not be started.",
        )
    })?;
    let _forwarder = child
        .stderr
        .take()
        .map(|stderr| output::Forwarder::spawn(stderr, filter, sink));
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
    build_deadline: Option<Instant>,
}

#[cfg(target_os = "macos")]
fn connect(
    candidate: &Candidate,
    deadline: Option<Instant>,
) -> Result<super::engine::Engine<'_>, CandidateError> {
    super::engine::Engine::connect_until(
        candidate,
        deadline.map_or_else(
            || Instant::now() + LEASE_WAIT,
            |deadline| deadline.min(Instant::now() + LEASE_WAIT),
        ),
        || deadline.is_some() && CANCEL_REQUESTED.load(Ordering::Acquire),
    )
}
#[cfg(not(target_os = "macos"))]
fn connect(
    candidate: &Candidate,
    deadline: Option<Instant>,
) -> Result<super::engine::Engine<'_>, CandidateError> {
    let _ = (LEASE_WAIT, deadline);
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

impl<'a> LivePool<'a> {
    fn identify(
        engine: super::engine::Engine<'a>,
    ) -> Result<(super::engine::Engine<'a>, PoolIdentity), CandidateError> {
        let info = engine.request(reqwest::Method::GET, "/v1.53/info", None)?;
        let engine_id = engine_id(&info)?;
        let identity = PoolIdentity {
            incarnation: engine.guest().incarnation().to_owned(),
            boot_id: engine.guest().boot_id().to_owned(),
            engine_id,
            socket: engine.guest().engine_socket()?,
        };
        Ok((engine, identity))
    }
}

fn engine_id(info: &Value) -> Result<String, CandidateError> {
    info["ID"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_graphic()))
        .map(str::to_owned)
        .ok_or_else(|| refusal("engine_protocol", "The engine reported no usable identity."))
}
impl<'a> BuildPool for LivePool<'a> {
    type Lease = super::engine::Engine<'a>;
    fn lease(&self) -> Result<(Self::Lease, PoolIdentity), CandidateError> {
        let engine = connect(self.candidate, self.build_deadline)?;
        verify_build_network(&engine)?;
        Self::identify(engine)
    }
    fn try_lease(&self) -> Result<(Self::Lease, PoolIdentity), CandidateError> {
        Self::identify(super::engine::Engine::connect(self.candidate)?)
    }
    fn observe_build(&self, image: &str) -> Result<(PoolIdentity, Option<Value>), CandidateError> {
        let observer = super::engine::Observer::connect(self.candidate)?;
        observer.info()?;
        let identity = PoolIdentity {
            incarnation: observer.guest().incarnation().to_owned(),
            boot_id: observer.guest().boot_id()?.to_owned(),
            engine_id: engine_id(&observer.identity_document()?)?,
            socket: observer.guest().engine_socket()?,
        };
        let inspected = match observer.image(image) {
            Ok(value) => Some(value),
            Err(error) if error.code == "engine_not_found" => None,
            Err(error) => return Err(error),
        };
        Ok((identity, inspected))
    }
    fn cleanup_lease(&self) -> Result<(Self::Lease, PoolIdentity), CandidateError> {
        Self {
            candidate: self.candidate,
            build_deadline: None,
        }
        .lease()
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
    fn tag_base(
        &self,
        lease: &Self::Lease,
        id: &str,
        reference: &str,
    ) -> Result<(), CandidateError> {
        let (repo, tag) = reference.rsplit_once(':').expect("generated alias");
        lease.request(
            reqwest::Method::POST,
            &format!("/v1.53/images/{id}/tag?repo={repo}&tag={tag}"),
            None,
        )?;
        Ok(())
    }
    fn untag_base(&self, lease: &Self::Lease, reference: &str) -> Result<(), CandidateError> {
        lease.request(
            reqwest::Method::DELETE,
            &format!("/v1.53/images/{reference}?force=false&noprune=true"),
            None,
        )?;
        Ok(())
    }
    fn builder(&self) -> Result<PathBuf, CandidateError> {
        artifact::verify_builder(self.candidate)?;
        Ok(artifact::builder_executable(self.candidate))
    }
    fn output(&self) -> Box<dyn Write + Send> {
        Box::new(std::io::stderr())
    }
    fn storage_available(&self, lease: &Self::Lease) -> Result<u64, CandidateError> {
        guest_storage_available(lease)
    }
    fn prune_cache(&self, lease: &Self::Lease, max_used: u64) -> Result<u64, CandidateError> {
        prune_build_cache(lease, max_used)
    }
}

/// Free bytes on the guest `/storage` ext4 disk, which holds `/var/lib/docker`.
pub(super) fn guest_storage_available(
    engine: &super::engine::Engine<'_>,
) -> Result<u64, CandidateError> {
    let output =
        engine
            .guest()
            .execute("df -Pk /storage | awk 'NR == 2 { print $4 }'", &[], None)?;
    output
        .trim()
        .parse::<u64>()
        .ok()
        .and_then(|kib| kib.checked_mul(1024))
        .ok_or_else(|| {
            refusal(
                "guest_protocol",
                "The guest reported no usable free-space value.",
            )
        })
}

/// Prune the engine's BuildKit cache to at most `max_used` bytes. Cache records only:
/// the build-prune endpoint never removes images, containers or volumes, and BuildKit
/// keeps records an active build uses.
pub(super) fn prune_build_cache(
    engine: &super::engine::Engine<'_>,
    max_used: u64,
) -> Result<u64, CandidateError> {
    let value = engine.request(
        reqwest::Method::POST,
        &format!("/v1.53/build/prune?max-used-space={max_used}"),
        None,
    )?;
    value["SpaceReclaimed"].as_u64().ok_or_else(|| {
        refusal(
            "engine_protocol",
            "The engine reported no reclaimed build-cache size.",
        )
    })
}

fn key_with_bases(
    key: &str,
    selected: &BTreeMap<String, BuildBase>,
) -> Result<String, CandidateError> {
    if selected.is_empty() {
        return Ok(key.into());
    }
    let pins: BTreeMap<_, _> = selected
        .iter()
        .map(|(name, base)| (name, &base.pinned_reference))
        .collect();
    serde_json::to_vec(&(key, pins))
        .map(|encoded| sha256_hex(&encoded))
        .map_err(|_| invalid("Cannot encode the build key."))
}

type EnsuredBase = (BuildBase, Option<super::image_ensure::EnsuredTag>);

fn select_build_base(
    candidate: &Candidate,
    reference: &str,
    policy: &super::image_policy::ImagePolicy,
    observer: Option<&super::engine::Observer<'_>>,
) -> Result<EnsuredBase, CandidateError> {
    use super::{
        image_ensure, image_platform::PlatformPolicy, image_policy::ImageTagMode, image_tag_store,
    };
    let platform = PlatformPolicy::Native;
    let mut tag = if reference.contains('@') {
        None
    } else {
        Some(image_tag_store::resolve(
            candidate, reference, policy, platform, observer,
        )?)
    };
    let pin = tag.as_ref().map_or(reference, |tag| &tag.pinned_reference);
    let proof = match image_ensure::recorded_proof(candidate, pin, platform)? {
        Some(proof) => proof,
        None if policy.tag_mode != ImageTagMode::Offline && tag.is_none() => {
            let resolved = registry_image::resolve_pinned(pin, policy, platform)?;
            image_ensure::publish_proof(candidate, pin, platform, &resolved.proof)?;
            resolved.proof
        }
        None => {
            return Err(refusal(
                "image_archive_offline_missing",
                "The verified base proof is missing.",
            ));
        }
    };
    let base = proof.verified_build_base(pin, policy.archive_limit)?;
    let tag = tag
        .as_mut()
        .map(|tag| {
            tag.confirm(|tag| {
                if tag.image_id != base.image_id {
                    return Err(refusal(
                        "native_build_base_image",
                        "The build base proof differs from the selected image.",
                    ));
                }
                Ok(super::image_ensure::EnsuredTag {
                    reference: tag.record.reference.clone(),
                    registry: tag.record.registry.clone(),
                    source_digest: tag.source_digest.clone(),
                    resolved_at_unix_seconds: tag.resolved_at_unix_seconds,
                    source: tag.source,
                    fallback_reason: tag.fallback_reason.clone(),
                })
            })
        })
        .transpose()?;
    Ok((base, tag))
}

/// Serialize selection only for this reference within the caller's build batch.
fn share_command_base(
    batch: &Path,
    reference: &str,
    policy: &super::image_policy::ImagePolicy,
    ensure: impl FnOnce(&str) -> Result<EnsuredBase, CandidateError>,
) -> Result<EnsuredBase, CandidateError> {
    if reference.contains('@') {
        return ensure(reference);
    }
    let root = batch.join(sha256_hex(reference.as_bytes()));
    let _lock = state::wait_for_image_lock(
        policy.image_wait(Duration::from_secs(60))?,
        reference,
        || state::Lock::acquire(&root),
    )?;
    let pin = root.join("pin.json");
    if pin.try_exists().map_err(state::io)? {
        let selected: String = state::read_bounded(&pin, 1024)?;
        // Use the immutable reference so a separate command refreshing the tag
        // cannot redirect this batch after its first selection.
        let (selected, _) = registry_image::pinned_syntax(&selected)?;
        let repo = reference
            .rsplit_once(':')
            .map_or(reference, |(repo, _)| repo);
        if !selected
            .strip_prefix(repo)
            .is_some_and(|suffix| suffix.starts_with('@'))
        {
            return Err(invalid(
                "The command base pin belongs to another repository.",
            ));
        }
        return ensure(&selected);
    }
    let result = ensure(reference)?;
    state::write(&pin, &result.0.pinned_reference)?;
    Ok(result)
}

struct BaseSelections {
    selected: BTreeMap<String, BuildBase>,
    fallbacks: Vec<super::image_ensure::EnsuredTag>,
    selections: BTreeMap<String, String>,
}

fn acquire_bases(
    inputs: &Inputs,
    prior_pins: &BTreeMap<String, String>,
    mut policy: super::image_policy::ImagePolicy,
    mut ensure: impl FnMut(
        &str,
        &super::image_policy::ImagePolicy,
    ) -> Result<EnsuredBase, CandidateError>,
    deadline: Instant,
) -> Result<BaseSelections, CandidateError> {
    let mut selected = BTreeMap::new();
    let mut fallbacks = Vec::new();
    let mut selections = BTreeMap::new();
    for base in &inputs.images {
        if Instant::now() >= deadline {
            return Err(late_stop(false));
        }
        let reference = base.reference.canonical();
        policy.command_image_pin = prior_pins
            .get(&reference)
            .map(|pin| registry_image::pinned_syntax(pin).map(|(canonical, _)| canonical))
            .transpose()?;
        let (resolved, tag) = ensure(&reference, &policy)
            .map_err(|error| error.with_build_base_reference(reference.clone()))?;
        if let Some(tag) = tag
            && tag.source == super::image_tag_store::TagSource::Offline
        {
            fallbacks.push(tag);
        }
        selections.insert(reference, resolved.pinned_reference.clone());
        selected.insert(base.context_name.clone(), resolved);
    }
    Ok(BaseSelections {
        selected,
        fallbacks,
        selections,
    })
}

fn base_registry_failed(error: &CandidateError) -> bool {
    let cause = error.cause_code.as_deref().unwrap_or(error.code);
    matches!(
        cause,
        "registry_http_429"
            | "registry_unreachable"
            | "registry_headers_stalled"
            | "registry_body_stalled"
    ) || cause
        .strip_prefix("registry_http_")
        .and_then(|status| status.parse::<u16>().ok())
        .is_some_and(|status| (500..600).contains(&status))
}

fn recover_base_error(
    error: CandidateError,
    mode: super::image_policy::ImageTagMode,
    deadline: Instant,
    reuse: impl FnOnce() -> Result<Option<BuildOutcome>, CandidateError>,
) -> Result<BuildOutcome, CandidateError> {
    use super::image_policy::ImageTagMode::{Normal, Offline, Refresh};
    let eligible = match mode {
        Normal => base_registry_failed(&error),
        Offline => error.code == "image_tag_offline_missing" && error.cause_code.is_none(),
        Refresh => false,
    };
    if eligible
        && Instant::now() < deadline
        && let Ok(Some(outcome)) = reuse()
    {
        return Ok(outcome);
    }
    Err(error)
}

/// `runtime build-image --request <private-file>`: build or reuse one native image.
pub fn build_image(candidate: &Candidate, request: &Path) -> Result<BuildOutcome, CandidateError> {
    let request_path = request;
    let request: BuildRequest = state::read_bounded(request_path, MAX_REQUEST_BYTES)?;
    let batch = if request.share_command_base_pins {
        let parent = request_path
            .parent()
            .ok_or_else(|| invalid("Missing build batch directory."))?;
        crate::reject_aliased_state(parent)?;
        state::check_private_directory(parent)?;
        Some(parent.join("base-pins"))
    } else {
        None
    };
    let flags: Vec<_> = request
        .image_policy_args
        .iter()
        .map(String::as_str)
        .collect();
    let mut policy = super::image_policy::ImagePolicy::from_flags(&flags)?;
    // Dockerfile admission allows Docker Hub only, even when service images
    // are allowed to use local registries.
    policy.local_registries.clear();
    policy.tag_mode = request.image_tag_mode;
    let prior_pins = request.command_base_pins.clone();
    let mut inputs = prepare(request, &builds_root(candidate))?;
    let deadline = Instant::now() + inputs.timeout;
    policy.build_deadline = Some(deadline);
    let pool = LivePool {
        candidate,
        build_deadline: Some(deadline),
    };
    use super::image_policy::ImageTagMode;
    let tag_mode = policy.tag_mode;
    let mut reuse = || -> Result<Option<BuildOutcome>, CandidateError> {
        if inputs.policy == Policy::Missing && tag_mode != ImageTagMode::Refresh {
            let mut local = policy.clone();
            local.tag_mode = ImageTagMode::Offline;
            if let Ok(bases) = acquire_bases(
                &inputs,
                &prior_pins,
                local,
                |reference, policy| select_build_base(candidate, reference, policy, None),
                deadline,
            ) {
                let key = key_with_bases(&inputs.key, &bases.selected)?;
                let original = std::mem::replace(&mut inputs.key, key);
                let reuse = reuse_receipt(candidate, &pool, &inputs, Some(&bases.selected))?;
                inputs.key = original;
                if let Some(mut outcome) = reuse {
                    outcome.base_selections = bases.selections;
                    return Ok(Some(outcome));
                }
            } else if let Some(outcome) = reuse_legacy(candidate, &pool, &inputs)? {
                return Ok(Some(outcome));
            }
        }
        Ok(None)
    };
    if let Some(outcome) = reuse()? {
        return Ok(outcome);
    }
    let acquisition_fence = match image_fence(candidate, libc::LOCK_SH) {
        Ok(fence) => Some(fence),
        Err(error) if error.code == "provider_busy" => None,
        Err(error) => return Err(error),
    };
    let _waited_fence = if acquisition_fence.is_none() {
        let fence = wait_for_image_fence(candidate, &policy)?;
        if let Some(outcome) = reuse()? {
            return Ok(outcome);
        }
        Some(fence)
    } else {
        None
    };
    let observer = super::engine::Observer::connect(candidate)?;
    let BaseSelections {
        selected,
        fallbacks,
        selections,
    } = match acquire_bases(
        &inputs,
        &prior_pins,
        policy,
        |reference, policy| {
            let ensure = |selected: &str| {
                if policy.tag_mode == ImageTagMode::Normal {
                    let mut recorded = policy.clone();
                    recorded.tag_mode = ImageTagMode::Offline;
                    if let Ok((base, _)) = select_build_base(candidate, selected, &recorded, None) {
                        return Ok((base, None));
                    }
                }
                select_build_base(candidate, selected, policy, Some(&observer))
            };
            match &batch {
                Some(batch) => share_command_base(batch, reference, policy, ensure),
                None => ensure(reference),
            }
        },
        deadline,
    ) {
        Ok(bases) => bases,
        Err(error) => {
            return recover_base_error(error, tag_mode, deadline, || {
                reuse_legacy(candidate, &pool, &inputs)
            });
        }
    };
    // Acquisition keeps the default signal dispositions, like ensure-image.
    // Exit releases its locks and the next cache writer recovers private
    // staging. No BuildKit client, temporary base alias or build receipt
    // exists yet. Install cooperative cancellation before starting BuildKit.
    let _signals = CancelSignals::install()?;
    let canceled = || CANCEL_REQUESTED.load(Ordering::Acquire);
    inputs.key = key_with_bases(&inputs.key, &selected)?;
    let mut outcome = run_with_bases(candidate, &pool, &inputs, &canceled, &selected, deadline)?;
    outcome.base_fallbacks = fallbacks;
    outcome.base_selections = selections;
    Ok(outcome)
}
