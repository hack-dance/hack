//! Narrow preflight for documented Unix Docker CLI plugin discovery.
//! Context/config selectors are observed, never replaced. Config parsing keeps
//! only cliPluginsExtraDirs; credentials and other fields are ignored, not copied.

use std::io::Read;
use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
use std::path::{Path, PathBuf};

use crate::{runner::CliRunner, source::trusted_tool_path};

pub(crate) struct Discovery {
    pub config_dir: Option<PathBuf>,
    pub unsupported_extra_selector: bool,
    pub system_dirs: Vec<PathBuf>,
    /// `DOCKER_HOST` and `DOCKER_CONTEXT` as the runner passes them on.
    pub docker_host: Option<String>,
    pub context: Option<String>,
}

impl Discovery {
    pub fn from_runner(runner: &CliRunner) -> Self {
        let config_dir = runner
            .env_value("DOCKER_CONFIG")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                runner
                    .env_value("HOME")
                    .filter(|p| !p.is_empty())
                    .map(|p| PathBuf::from(p).join(".docker"))
            });
        let text = |key| {
            runner
                .env_value(key)
                .and_then(|v| v.into_string().ok())
                .filter(|v| !v.is_empty())
        };
        Self {
            docker_host: text("DOCKER_HOST"),
            context: text("DOCKER_CONTEXT"),
            config_dir,
            // This selector's encoding/precedence is not part of the Unix
            // configfile contract below. Do not guess or silently ignore it.
            unsupported_extra_selector: runner
                .env_value("DOCKER_CLI_PLUGIN_EXTRA_DIRS")
                .is_some_and(|v| !v.is_empty()),
            // docker/cli cli-plugins/manager/manager_unix.go (standard Unix
            // builds). Custom discovery requires a separate qualified adapter.
            system_dirs: [
                "/usr/local/lib/docker/cli-plugins",
                "/usr/local/libexec/docker/cli-plugins",
                "/usr/lib/docker/cli-plugins",
                "/usr/libexec/docker/cli-plugins",
            ]
            .map(PathBuf::from)
            .to_vec(),
        }
    }
}

#[derive(Default, serde::Deserialize)]
struct PluginConfig {
    #[serde(default, rename = "cliPluginsExtraDirs")]
    extra_dirs: Option<Vec<PathBuf>>,
    #[serde(default, rename = "currentContext")]
    current_context: Option<String>,
}

/// Doctor's automatic `docker info` must reach only a local Unix socket: an
/// SSH or TCP endpoint makes Docker start other programs (for example `ssh`
/// and its configured helpers) that these checks do not inspect.
fn local_endpoint(
    discovery: &Discovery,
    config: &Path,
    configured: Option<&str>,
) -> Result<(), &'static str> {
    const REMOTE: &str =
        "Docker is set to a remote endpoint; Doctor's automatic checks only use a local socket";
    if let Some(host) = &discovery.docker_host
        && !host.starts_with("unix://")
    {
        return Err(REMOTE);
    }
    let Some(name) = discovery
        .context
        .as_deref()
        .or(configured)
        .filter(|name| *name != "default")
    else {
        return Ok(());
    };
    #[derive(serde::Deserialize)]
    struct Meta {
        #[serde(rename = "Name")]
        name: String,
        #[serde(rename = "Endpoints", default)]
        endpoints: std::collections::BTreeMap<String, Endpoint>,
    }
    #[derive(serde::Deserialize)]
    struct Endpoint {
        #[serde(rename = "Host", default)]
        host: Option<String>,
    }
    const UNKNOWN: &str =
        "The selected Docker context's endpoint is unknown; Docker was not invoked";
    // Docker loads exactly contexts/meta/<sha256(name)>/meta.json.
    let digest = <sha2::Sha256 as sha2::Digest>::digest(name.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    let dir = config.join("contexts/meta").join(hex);
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    if trusted_tool_path(&dir, uid, true).is_none() {
        return Err(UNKNOWN);
    }
    // No symlink and no blocking open: a FIFO or device must not hang Doctor.
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
            .open(dir.join("meta.json"))
            .map_err(|_| UNKNOWN)?
    };
    let meta = file.metadata().map_err(|_| UNKNOWN)?;
    // The ACL check is by path; the opened descriptor must still be that path's
    // file (same device and inode), so a swap in between is refused.
    let same_file = std::fs::symlink_metadata(dir.join("meta.json"))
        .is_ok_and(|path| path.dev() == meta.dev() && path.ino() == meta.ino());
    if !meta.is_file()
        || (meta.uid() != uid && meta.uid() != 0)
        || meta.mode() & 0o022 != 0
        || meta.len() > 64 * 1024
        || !same_file
        || !crate::doctor_acl::controlled(&dir.join("meta.json"))
    {
        return Err(UNKNOWN);
    }
    let meta: Meta = serde_json::from_reader(std::io::BufReader::new(file).take(64 * 1024))
        .map_err(|_| UNKNOWN)?;
    if meta.name != name {
        return Err(UNKNOWN);
    }
    match meta.endpoints.get("docker").and_then(|e| e.host.as_deref()) {
        Some(host) if host.starts_with("unix://") => Ok(()),
        Some(_) => Err(REMOTE),
        None => Err(UNKNOWN),
    }
}

// Unlike private PATH wrappers, Docker later resolves the original names.
// Check original prefixes AND every lexical link target, not only realpath:
// an attacker must not be able to replace an intermediate alias afterward.
pub(crate) fn guarded_names(
    path: &Path,
    uid: u32,
    links_left: &mut usize,
    as_ancestor: bool,
) -> bool {
    guarded_names_with(path, uid, links_left, as_ancestor, |_, _| false)
}

pub(crate) fn guarded_names_with(
    path: &Path,
    uid: u32,
    links_left: &mut usize,
    as_ancestor: bool,
    writable_dir: fn(&Path, &std::fs::Metadata) -> bool,
) -> bool {
    if !path.is_absolute() {
        return false;
    }
    for (index, component) in path.ancestors().enumerate() {
        let Ok(meta) = std::fs::symlink_metadata(component) else {
            return false;
        };
        if (meta.uid() != uid && meta.uid() != 0) || !crate::doctor_acl::controlled(component) {
            return false;
        }
        if meta.file_type().is_symlink() {
            if *links_left == 0 {
                return false;
            }
            *links_left -= 1;
            let Ok(target) = std::fs::read_link(component) else {
                return false;
            };
            let target = if target.is_absolute() {
                target
            } else {
                let Some(parent) = component.parent() else {
                    return false;
                };
                parent.join(target)
            };
            if !guarded_names_with(
                &target,
                uid,
                links_left,
                as_ancestor || index > 0,
                writable_dir,
            ) {
                return false;
            }
        } else {
            let sticky_root = (index > 0 || as_ancestor)
                && meta.is_dir()
                && meta.uid() == 0
                && meta.mode() & 0o1000 != 0;
            let allowed_dir = (index > 0 || as_ancestor) && writable_dir(component, &meta);
            if (index > 0 && !meta.is_dir())
                || (meta.mode() & 0o022 != 0 && !sticky_root && !allowed_dir)
            {
                return false;
            }
        }
    }
    true
}

/// The `PATH` entries that are directories no other user can change.
pub(crate) fn controlled_path_entries(path: &str) -> Vec<&str> {
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    path.split(':')
        .filter(|entry| guarded_dir(Path::new(entry), uid).is_some_and(|real| real.is_dir()))
        .collect()
}

fn guarded_dir(path: &Path, uid: u32) -> Option<PathBuf> {
    if !guarded_names(path, uid, &mut 64, false) {
        return None;
    }
    trusted_tool_path(path, uid, true)
}

/// Missing candidates are proven absent only below a protected existing
/// ancestor. A dangling link, unreadable path or writable ancestor is unknown.
fn present(path: &Path, uid: u32) -> Result<bool, &'static str> {
    if !path.is_absolute() {
        return Err("relative Docker plugin discovery is unsupported");
    }
    let mut current = path;
    loop {
        match std::fs::symlink_metadata(current) {
            Ok(_) if current == path => return Ok(true),
            Ok(_) => {
                return guarded_dir(current, uid)
                    .map(|_| false)
                    .ok_or("Docker plugin absence cannot be proven below an untrusted ancestor");
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                current = current
                    .parent()
                    .ok_or("Docker plugin ancestry is unknown")?;
            }
            Err(_) => return Err("Docker plugin discovery is unreadable"),
        }
    }
}

fn config_file(path: &Path, uid: u32) -> Result<PluginConfig, &'static str> {
    if !present(path, uid)? {
        return Ok(PluginConfig::default());
    }
    let real = std::fs::canonicalize(path).map_err(|_| "Docker plugin config target is unknown")?;
    let meta =
        std::fs::metadata(&real).map_err(|_| "Docker plugin config metadata is unreadable")?;
    if !guarded_names(path, uid, &mut 64, false)
        || !meta.is_file()
        || (meta.uid() != uid && meta.uid() != 0)
        || meta.mode() & 0o022 != 0
        || real
            .parent()
            .and_then(|p| trusted_tool_path(p, uid, true))
            .is_none()
    {
        return Err("Docker plugin config is not owner-controlled");
    }
    const MAX_CONFIG: u64 = 1024 * 1024;
    if meta.len() > MAX_CONFIG {
        return Err("Docker plugin config exceeds the validation bound");
    }
    let file = std::fs::File::open(real).map_err(|_| "Docker plugin config is unreadable")?;
    // Streaming serde ignores all fields other than this public path list;
    // never retain/log/copy auths, credential helper values or context contents.
    serde_json::from_reader(std::io::BufReader::new(file).take(MAX_CONFIG + 1))
        .map_err(|_| "Docker plugin config is invalid or unsupported")
}

/// Compose Doctor resolves Mutagen before PATH. Validate that fixed override
/// or managed candidate without changing its selection or reading its contents.
pub(crate) fn validate_helpers(runner: &CliRunner) -> Result<NativePin, &'static str> {
    let selector = |key| -> Result<Option<String>, &'static str> {
        runner
            .env_value(key)
            .map(|v| {
                v.into_string()
                    .map(|v| v.trim().to_owned())
                    .map_err(|_| "Doctor helper selector is not UTF-8")
            })
            .transpose()
            .map(|v| v.filter(|v| !v.is_empty()))
    };
    let candidate = if let Some(path) = selector("HACK_MUTAGEN_PATH")? {
        PathBuf::from(path)
    } else {
        let home = if let Some(path) = selector("HACK_HOME")? {
            PathBuf::from(path)
        } else {
            PathBuf::from(selector("HOME")?.ok_or("Doctor helper home is unknown")?).join(".hack")
        };
        home.join("bin/mutagen")
    };
    if !candidate.is_absolute() {
        return Err("relative Doctor Mutagen helper selection is unsupported");
    }
    let uid = unsafe { libc::getuid() };
    // The CLI executes this helper directly, so its #! interpreter must pass
    // the same rule as PATH tools.
    if present(&candidate, uid)?
        && trusted_tool_path(&candidate, uid, false)
            // The CLI runs the helper under Doctor's private wrapper PATH.
            .is_none_or(|real| !crate::source::trusted_interpreter(&real, uid, 4, true))
    {
        return Err("Doctor absolute helper or its ancestors/ACLs are untrusted");
    }
    // A native candidate runtime is spawned by absolute path with a narrowed
    // environment (not the wrapper PATH), so the env #! form is refused.
    // Companions are spawned by absolute path with a narrowed environment
    // (not the wrapper PATH), so the env #! form is refused.
    let companion_ok = |path: &Path, why: &'static str| -> Result<bool, &'static str> {
        if present(path, uid)? {
            if trusted_tool_path(path, uid, false)
                .is_none_or(|real| !crate::source::trusted_interpreter(&real, uid, 4, false))
            {
                return Err(why);
            }
            return Ok(true);
        }
        Ok(false)
    };
    const NATIVE_UNTRUSTED: &str = "Native runtime binary or its ancestors/ACLs are untrusted";
    const SUPERVISOR_UNTRUSTED: &str =
        "Lifecycle supervisor binary or its ancestors/ACLs are untrusted";
    // Companions the CLI takes from beside its own executable
    // (`process.execPath`). For a compiled CLI that is the CLI's directory,
    // canonical or as given. A `#!` launcher's eventual executable is not
    // knowable here (see the README's Doctor limits).
    let compiled_dirs: Vec<PathBuf> = runner
        .program_path()
        .and_then(|program| {
            let real = std::fs::canonicalize(&program).ok()?;
            let mut head = [0_u8; 2];
            let launcher = std::fs::File::open(&real)
                .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut head))
                .map_or(true, |()| head == *b"#!");
            (!launcher).then(|| {
                [real.parent(), program.parent()]
                    .into_iter()
                    .flatten()
                    .map(Path::to_path_buf)
                    .collect()
            })
        })
        .unwrap_or_default();
    // The lifecycle supervisor is run by Doctor's project checks for projects
    // using the supervisor runner; a compiled CLI ignores any selector for it.
    for dir in &compiled_dirs {
        companion_ok(&dir.join("hack-lifecycle-supervisor"), SUPERVISOR_UNTRUSTED)?;
    }
    if let Some(native) = selector("HACK_NATIVE_BINARY")? {
        let native = PathBuf::from(native);
        if !native.is_absolute() {
            return Err("relative native runtime selection is unsupported");
        }
        companion_ok(&native, NATIVE_UNTRUSTED)?;
        return Ok(NativePin::Selected);
    }
    // Unset: the CLI falls back to `hack-native` beside its own executable.
    // A `#!` launcher or unresolvable program gets an absent private pin
    // instead of letting the CLI search.
    if compiled_dirs.is_empty() {
        return Ok(NativePin::Unavailable);
    }
    let mut found = None;
    for dir in &compiled_dirs {
        let candidate = dir.join("hack-native");
        if companion_ok(&candidate, NATIVE_UNTRUSTED)? && found.is_none() {
            found = Some(candidate);
        }
    }
    Ok(found.map_or(NativePin::Absent, NativePin::Adjacent))
}

/// Relative to the private wrapper directory; see [`NativePin::apply`].
pub(crate) const UNAVAILABLE_NATIVE: &str = "native-unavailable/hack-native";

/// The native runtime selection Doctor's runs use when `HACK_NATIVE_BINARY`
/// is unset. Every variant has been checked; [`NativePin::apply`] keeps the
/// CLI from choosing anything else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NativePin {
    /// `HACK_NATIVE_BINARY` was set and checked; the CLI uses it as is.
    Selected,
    /// A checked `hack-native` beside the CLI executable; pinned by path.
    Adjacent(PathBuf),
    /// No `hack-native` beside the CLI, and its absence is protected by
    /// owner-controlled ancestry; the CLI's own fallback finds nothing.
    Absent,
    /// The CLI's fallback location cannot be known (a `#!` launcher or an
    /// unresolvable program); a path that cannot exist is pinned.
    Unavailable,
}

impl NativePin {
    /// `private_dir` must be Doctor's private wrapper directory, which only
    /// this user can write. The wrapper scan creates only regular files there
    /// (named after PATH tools), so a path one level below any entry name can
    /// never exist: the unavailable pin stays absent even if a PATH tool is
    /// named like its first component.
    pub(crate) fn apply(&self, runner: CliRunner, private_dir: &Path) -> CliRunner {
        match self {
            Self::Selected | Self::Absent => runner,
            Self::Adjacent(path) => match path.to_str() {
                Some(path) => runner.with_env("HACK_NATIVE_BINARY", path),
                None => Self::Unavailable.apply(runner, private_dir),
            },
            Self::Unavailable => match private_dir.join(UNAVAILABLE_NATIVE).to_str() {
                Some(path) => runner.with_env("HACK_NATIVE_BINARY", path),
                // The wrapper PATH is required to be UTF-8 before this runs.
                None => runner,
            },
        }
    }
}

/// Success proves only the documented Unix discovery inputs inspected here.
/// It neither sandboxes plugin contents nor qualifies custom Docker builds.
pub(crate) fn validate(discovery: &Discovery) -> Result<(), &'static str> {
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    if discovery.unsupported_extra_selector {
        return Err(
            "DOCKER_CLI_PLUGIN_EXTRA_DIRS discovery is unsupported; Docker was not invoked",
        );
    }
    let config = discovery
        .config_dir
        .as_ref()
        .ok_or("Docker config selection is unknown")?;
    if present(config, uid)? && guarded_dir(config, uid).is_none() {
        return Err("Docker config directory is not owner-controlled");
    }
    let parsed = config_file(&config.join("config.json"), uid)?;
    local_endpoint(discovery, config, parsed.current_context.as_deref())?;
    let mut dirs = vec![config.join("cli-plugins")];
    dirs.extend(parsed.extra_dirs.unwrap_or_default());
    dirs.extend(discovery.system_dirs.iter().cloned());
    if dirs.len() > 64 {
        return Err("Docker plugin discovery exceeds 64 directories");
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut entries = 0;
    for dir in dirs {
        if !present(&dir, uid)? {
            continue;
        }
        let real = guarded_dir(&dir, uid)
            .ok_or("Docker plugin directory or target is not owner-controlled")?;
        if !seen.insert(real.clone()) {
            continue;
        }
        for entry in std::fs::read_dir(real).map_err(|_| "Docker plugin directory is unreadable")? {
            entries += 1;
            if entries > 8192 {
                return Err("Docker plugin discovery exceeds 8192 entries");
            }
            let entry = entry.map_err(|_| "Docker plugin entry is unreadable")?;
            if !entry.file_name().as_bytes().starts_with(b"docker-") {
                continue;
            }
            // Docker runs plugins by absolute path, so the interpreter of a
            // script plugin must pass the same rule as PATH tools.
            if !guarded_names(&entry.path(), uid, &mut 64, false)
                || trusted_tool_path(&entry.path(), uid, false)
                    .is_none_or(|real| !crate::source::trusted_interpreter(&real, uid, 4, true))
            {
                return Err(
                    "Docker plugin executable or symlink target is untrusted or unprovable",
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors_follow_effective_runner_context_without_reading_actual_config() {
        let runner = CliRunner::new("unused-fixture-cli")
            .with_env("HOME", "/fixture/user-root")
            .with_env("DOCKER_CONFIG", "/fixture/selected-client")
            .with_env("DOCKER_CONTEXT", "fixture-selected-context")
            .with_env("DOCKER_CLI_PLUGIN_EXTRA_DIRS", "");
        assert_eq!(
            Discovery::from_runner(&runner).config_dir,
            Some("/fixture/selected-client".into())
        );
        let empty = runner.clone().with_env("DOCKER_CONFIG", "");
        assert_eq!(
            Discovery::from_runner(&empty).config_dir,
            Some("/fixture/user-root/.docker".into())
        );
        let opaque = runner
            .clone()
            .with_env("DOCKER_CLI_PLUGIN_EXTRA_DIRS", "/fixture/opaque");
        assert!(Discovery::from_runner(&opaque).unsupported_extra_selector);
        assert_eq!(
            runner.env_value("DOCKER_CONTEXT").unwrap(),
            "fixture-selected-context"
        );
    }
}
