//! Bounded, explicit image acquisition policy: byte budgets, local registry opt-ins and
//! the Docker configuration directory that may supply registry credentials.
//!
//! Every value is supplied by the caller (CLI flags); nothing is read from the process
//! environment, so a test or embedding never inherits a user's settings implicitly.
//! Budgets are configurable within fixed hard ceilings, so a policy can relax the
//! defaults for large development images but never remove the bound.
use crate::CandidateError;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

const MIB: u64 = 1024 * 1024;
/// Default compressed archive budget for one image: fits ordinary language and database
/// development images (typically 50 MiB to 1 GiB compressed).
pub const DEFAULT_ARCHIVE_LIMIT: u64 = 2 * 1024 * MIB;
/// Fixed upper bound for any configured per-image archive budget and for any archive the
/// cache or loader accepts.
pub const ARCHIVE_CEILING: u64 = 8 * 1024 * MIB;
/// Expanded layer bytes may be this many times the archive budget.
const EXPANSION_FACTOR: u64 = 5;
/// Default total bytes of archives retained in one candidate's image cache.
pub const DEFAULT_CACHE_LIMIT: u64 = 16 * 1024 * MIB;
/// Fixed upper bound for a configured cache budget.
pub const CACHE_CEILING: u64 = 256 * 1024 * MIB;
/// Smallest configurable archive budget; smaller values cannot hold real images.
const MIN_ARCHIVE_LIMIT: u64 = 16 * MIB;
/// Local registry opt-ins a single request may name.
const MAX_LOCAL_REGISTRIES: usize = 16;

/// Mutable tags retain a verified resolution for one day by default.
pub const DEFAULT_TAG_TTL_SECONDS: u64 = 24 * 60 * 60;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImageTagMode {
    #[default]
    Normal,
    Refresh,
    Offline,
}

fn invalid(message: impl Into<crate::ErrorMessage>) -> CandidateError {
    CandidateError::new("image_policy", message)
}

/// One explicitly allowed local registry and the transport it uses.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalRegistry {
    /// Exact `host[:port]` as it appears in normalized image references.
    pub domain: String,
    /// True only when the opt-in was written as `http://host[:port]`.
    pub plain_http: bool,
}

#[derive(Clone, Debug)]
pub struct ImagePolicy {
    /// Compressed archive budget for one image.
    pub archive_limit: u64,
    /// Total expanded (decompressed) bytes across one archive's members.
    pub expanded_limit: u64,
    /// Total archive bytes the candidate's image cache may retain.
    pub cache_limit: u64,
    /// Maximum age at which an ordinary start can use a tag resolution without the registry.
    pub tag_ttl_seconds: u64,
    /// Override the ordinary tag lookup for an explicit refresh or an offline command.
    pub tag_mode: ImageTagMode,
    pub(crate) short_tag_refresh: bool,
    pub(crate) build_deadline: Option<Instant>,
    pub(super) retention_root: Option<PathBuf>,
    pub(crate) command_image_pin: Option<String>,
    /// Registries that are refused as local unless named here.
    pub local_registries: Vec<LocalRegistry>,
    /// Docker configuration directory for read-only credential lookup. `None` means
    /// `$HOME/.docker`; the directory is read only when a registry challenges a request.
    pub docker_config: Option<PathBuf>,
    /// Directories searched for `docker-credential-*` helpers. `None` means `PATH`.
    pub(crate) helper_path: Option<Vec<PathBuf>>,
    /// Host-name lookup for registry connections. `None` means the system resolver; only
    /// tests replace it.
    pub(crate) host_lookup: Option<super::registry_image::HostLookup>,
}

impl Default for ImagePolicy {
    fn default() -> Self {
        Self {
            archive_limit: DEFAULT_ARCHIVE_LIMIT,
            expanded_limit: DEFAULT_ARCHIVE_LIMIT * EXPANSION_FACTOR,
            cache_limit: DEFAULT_CACHE_LIMIT,
            tag_ttl_seconds: DEFAULT_TAG_TTL_SECONDS,
            tag_mode: ImageTagMode::Normal,
            short_tag_refresh: false,
            build_deadline: None,
            retention_root: None,
            command_image_pin: None,
            local_registries: Vec::new(),
            docker_config: None,
            helper_path: None,
            host_lookup: None,
        }
    }
}

fn mebibytes(value: &str, min: u64, max: u64) -> Result<u64, CandidateError> {
    let parsed =
        (!value.is_empty() && value.len() <= 8 && value.bytes().all(|b| b.is_ascii_digit()))
            .then(|| value.parse::<u64>().ok())
            .flatten()
            .and_then(|mib| mib.checked_mul(MIB))
            .filter(|bytes| (min..=max).contains(bytes));
    parsed.ok_or_else(|| {
        invalid("Image budget must be a whole number of MiB within its fixed bounds.")
    })
}

impl ImagePolicy {
    pub(super) fn image_wait(&self, default: Duration) -> Result<Duration, CandidateError> {
        match self.build_deadline {
            Some(deadline) => deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| {
                    CandidateError::new(
                        "native_build_timeout",
                        "The image build exceeded its time budget.",
                    )
                }),
            None => Ok(default),
        }
    }

    /// The local registry opt-in for `domain`, if any.
    pub fn local_registry(&self, domain: &str) -> Option<&LocalRegistry> {
        self.local_registries.iter().find(|r| r.domain == domain)
    }

    /// Parse trailing policy flags of an image command. Accepted flags, each at most once
    /// except `--allow-local-registry`:
    ///
    /// - `--image-budget-mib N`: per-image compressed archive budget (16..=8192 MiB);
    ///   the expanded budget is five times this value.
    /// - `--image-cache-mib N`: total cache budget (16..=262144 MiB, at least the image budget).
    /// - `--allow-local-registry [http://]HOST[:PORT]`: admit one local registry by exact
    ///   domain; the `http://` prefix selects plain HTTP, otherwise HTTPS is required.
    /// - `--docker-config DIR`: absolute Docker configuration directory for credentials.
    pub fn from_flags(flags: &[&str]) -> Result<Self, CandidateError> {
        let mut policy = Self::default();
        let (mut budget, mut cache, mut config) = (false, false, false);
        let (mut ttl, mut tag_mode) = (false, false);
        let mut rest = flags;
        while let [flag, value, tail @ ..] = rest {
            match *flag {
                "--image-budget-mib" if !budget => {
                    budget = true;
                    policy.archive_limit = mebibytes(value, MIN_ARCHIVE_LIMIT, ARCHIVE_CEILING)?;
                    policy.expanded_limit = policy.archive_limit * EXPANSION_FACTOR;
                }
                "--image-cache-mib" if !cache => {
                    cache = true;
                    policy.cache_limit = mebibytes(value, MIN_ARCHIVE_LIMIT, CACHE_CEILING)?;
                }
                "--allow-local-registry"
                    if policy.local_registries.len() < MAX_LOCAL_REGISTRIES =>
                {
                    let (domain, plain_http) = match value.strip_prefix("http://") {
                        Some(domain) => (domain, true),
                        None => (*value, false),
                    };
                    if super::registry_image::local_domain_syntax(domain).is_err()
                        || policy.local_registry(domain).is_some()
                    {
                        return Err(invalid(
                            "A local registry opt-in must be a unique [http://]host[:port].",
                        ));
                    }
                    policy.local_registries.push(LocalRegistry {
                        domain: domain.to_owned(),
                        plain_http,
                    });
                }
                "--image-tag-ttl-seconds" if !ttl => {
                    ttl = true;
                    policy.tag_ttl_seconds = value
                        .parse::<u64>()
                        .ok()
                        .filter(|seconds| *seconds <= 2_592_000 && value.bytes().all(|byte| byte.is_ascii_digit()))
                        .ok_or_else(|| {
                            invalid("Image tag lifetime must be a whole number from 0 to 2592000 seconds.")
                        })?;
                }
                "--image-tag-mode" if !tag_mode => {
                    tag_mode = true;
                    policy.tag_mode = match *value {
                        "normal" => ImageTagMode::Normal,
                        "refresh" => ImageTagMode::Refresh,
                        "offline" => ImageTagMode::Offline,
                        _ => return Err(invalid("Use image tag mode normal, refresh or offline.")),
                    };
                }
                "--command-image-pin" if policy.command_image_pin.is_none() => {
                    policy.command_image_pin = Some(super::registry_image::pinned_syntax(value)?.0);
                }
                "--docker-config" if !config => {
                    config = true;
                    let path = PathBuf::from(value);
                    if !path.is_absolute() || value.len() > 1024 {
                        return Err(invalid(
                            "The Docker configuration directory must be an absolute path.",
                        ));
                    }
                    policy.docker_config = Some(path);
                }
                _ => return Err(invalid("Unsupported or repeated image policy flag.")),
            }
            rest = tail;
        }
        if !rest.is_empty() {
            return Err(invalid("Image policy flags require a value."));
        }
        if policy.cache_limit < policy.archive_limit {
            return Err(invalid(
                "The image cache budget must be at least one image budget.",
            ));
        }
        Ok(policy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_fit_development_images_and_flags_stay_within_fixed_ceilings() {
        let policy = ImagePolicy::from_flags(&[]).unwrap();
        assert_eq!(policy.archive_limit, DEFAULT_ARCHIVE_LIMIT);
        assert_eq!(policy.expanded_limit, 5 * DEFAULT_ARCHIVE_LIMIT);
        assert_eq!(policy.cache_limit, DEFAULT_CACHE_LIMIT);
        assert!(policy.local_registries.is_empty() && policy.docker_config.is_none());
        let policy = ImagePolicy::from_flags(&[
            "--image-budget-mib",
            "4096",
            "--image-cache-mib",
            "65536",
            "--allow-local-registry",
            "http://localhost:5000",
            "--allow-local-registry",
            "registry.local:443",
            "--docker-config",
            "/fixture/docker",
        ])
        .unwrap();
        assert_eq!(policy.archive_limit, 4096 * MIB);
        assert_eq!(policy.expanded_limit, 5 * 4096 * MIB);
        assert_eq!(policy.cache_limit, 65536 * MIB);
        assert!(policy.local_registry("localhost:5000").unwrap().plain_http);
        assert!(
            !policy
                .local_registry("registry.local:443")
                .unwrap()
                .plain_http
        );
        assert!(policy.local_registry("localhost").is_none());
        for flags in [
            &["--image-budget-mib", "8193"][..],
            &["--image-budget-mib", "15"],
            &["--image-budget-mib", "-1"],
            &["--image-budget-mib", "1e3"],
            &["--image-budget-mib", "64", "--image-budget-mib", "64"],
            &["--image-cache-mib", "262145"],
            &["--image-budget-mib", "4096", "--image-cache-mib", "1024"],
            &["--allow-local-registry", "https://localhost:5000"],
            &["--allow-local-registry", "localhost:5000/path"],
            &["--allow-local-registry", "user:secret@localhost"],
            &[
                "--allow-local-registry",
                "localhost",
                "--allow-local-registry",
                "localhost",
            ],
            &["--docker-config", "relative/docker"],
            &["--docker-config"],
            &["--unknown", "1"],
        ] {
            assert!(ImagePolicy::from_flags(flags).is_err(), "{flags:?}");
        }
    }
}
