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
        Self {
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
            if !guarded_names(&target, uid, links_left, as_ancestor || index > 0) {
                return false;
            }
        } else {
            let sticky_root = (index > 0 || as_ancestor)
                && meta.is_dir()
                && meta.uid() == 0
                && meta.mode() & 0o1000 != 0;
            if (index > 0 && !meta.is_dir()) || (meta.mode() & 0o022 != 0 && !sticky_root) {
                return false;
            }
        }
    }
    true
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
pub(crate) fn validate_helpers(runner: &CliRunner) -> Result<(), &'static str> {
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
    if present(&candidate, uid)? && trusted_tool_path(&candidate, uid, false).is_none() {
        return Err("Doctor absolute helper or its ancestors/ACLs are untrusted");
    }
    Ok(())
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
            if !guarded_names(&entry.path(), uid, &mut 64, false)
                || trusted_tool_path(&entry.path(), uid, false).is_none()
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
