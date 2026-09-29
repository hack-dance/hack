//! Host-side policy for a prepared-base verifier's inventory (`guest-prepared-inventory.sh`).
//!
//! The guest script only lists and reads both disks of a verifier boot, before any pool setup.
//! This module parses that raw report and decides, against explicit allow-lists, whether the
//! base holds only reusable runtime preparation: engine data without identity, containers or
//! volumes; network tools installed under the base-scoped owner with every file matching the
//! receipt's checksums; and nothing else. Every entry outside the allow-lists is reported by path
//! in [`Inventory::unexpected`]; verification passes only when that list is empty.
use super::prepared_store::Inventory;
use crate::CandidateError;
use base64::Engine;
use std::collections::{BTreeMap, BTreeSet};

fn malformed(detail: &str) -> CandidateError {
    CandidateError::new(
        "prepared_base_unverified",
        format!("The verifier inventory is malformed ({detail}); the base was not verified."),
    )
}

/// Top-level entries of the storage disk that may exist in a base.
const STORAGE_TOP: [&str; 9] = [
    "docker",
    "containerd",
    "lost+found",
    // SmolVM recreates these empty directories at every boot.
    "layers",
    "configs",
    "manifests",
    "overlays",
    "workspace",
    "containers",
];

/// Top-level entries of the engine data root that may exist in a base.
const DOCKER_TOP: [&str; 9] = [
    "containers",
    "image",
    "network",
    "overlay2",
    "plugins",
    "runtimes",
    "swarm",
    "tmp",
    "volumes",
];

/// Engine volume-store bookkeeping that is not a volume.
const VOLUME_BOOKKEEPING: [&str; 2] = ["metadata.db", "backingFsBlockDev"];

/// Files the network-tools installation writes besides the package files its receipt lists
/// (the receipt itself and the apk database, including its empty lock file).
const TOOLS_UPPER_FILES: [&str; 10] = [
    "etc/hack-local-network-tools/owner",
    "etc/hack-local-network-tools/identity",
    "etc/hack-local-network-tools/inventory",
    "etc/hack-local-network-tools/files",
    "etc/hack-local-network-tools/ready",
    "etc/apk/world",
    "lib/apk/db/installed",
    "lib/apk/db/triggers",
    "lib/apk/db/scripts.tar",
    "lib/apk/db/lock",
];

/// Other overlay files a clean seed may leave: the provider's resolver file and the iptables
/// lock, neither of which carries pool identity.
const UPPER_FILES: [&str; 2] = ["etc/resolv.conf", "run/xtables.lock"];

/// Symbolic links a clean seed may leave: guest setup's engine socket alias (`/var/run` links
/// to `/run` in the rootfs) and the provider's `/workspace` link. Targets are not reported;
/// package symlinks are covered by the receipt's checksum run instead.
const UPPER_LINKS: [&str; 2] = ["run/docker.sock", "workspace"];

/// Empty mount points and working directories the provider, guest setup and the iptables
/// package create. Only directories: any file below them is reported separately.
const UPPER_DIRS: [&str; 16] = [
    "opt/hack-engine",
    "var/lib/docker",
    "var/lib/containerd",
    "run/hack-local",
    "run/smolvm",
    "run/smolvm/virtiofs",
    "etc/iptables",
    "var/lib/iptables",
    "var/lib/ip6tables",
    "storage",
    "oldroot",
    "proc",
    "sys",
    "dev",
    "tmp",
    "run",
];

/// The provider creates one empty mount point per shared directory tag at every boot.
fn provider_mount_point(path: &str) -> bool {
    path.strip_prefix("run/smolvm/virtiofs/")
        .is_some_and(|tag| !tag.is_empty() && !tag.contains('/'))
}

/// The raw report, one field per line: `key base64` (or `key value` for flags).
#[derive(Debug, Default)]
struct Raw {
    fields: BTreeMap<String, String>,
    storage_dirs: BTreeMap<String, String>,
}

fn parse(report: &str) -> Result<Raw, CandidateError> {
    let mut raw = Raw::default();
    let mut ended = false;
    for line in report.lines() {
        if ended {
            return Err(malformed("text after the end marker"));
        }
        let mut parts = line.splitn(3, ' ');
        let key = parts.next().unwrap_or_default();
        let first = parts.next().unwrap_or_default();
        match key {
            "end" if first == "prepared-inventory-v1" => ended = true,
            "storage_dir" => {
                if !STORAGE_TOP.contains(&first) {
                    return Err(malformed("unknown storage directory"));
                }
                raw.storage_dirs
                    .insert(first.into(), parts.next().unwrap_or_default().into());
            }
            _ => {
                if parts.next().is_some() || raw.fields.insert(key.into(), first.into()).is_some() {
                    return Err(malformed("duplicate or extra field"));
                }
            }
        }
    }
    if !ended {
        return Err(malformed("missing end marker"));
    }
    Ok(raw)
}

fn field<'a>(raw: &'a Raw, key: &str) -> Result<&'a str, CandidateError> {
    raw.fields
        .get(key)
        .map(String::as_str)
        .ok_or_else(|| malformed(key))
}

fn decode(value: &str) -> Result<Vec<u8>, CandidateError> {
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| malformed("invalid base64"))
}

/// Decode a NUL-separated list of `./relative` paths into relative paths.
fn paths(value: &str) -> Result<Vec<String>, CandidateError> {
    let bytes = decode(value)?;
    let mut result = Vec::new();
    for entry in bytes
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let text = std::str::from_utf8(entry).map_err(|_| malformed("non-UTF-8 path"))?;
        let relative = text
            .strip_prefix("./")
            .ok_or_else(|| malformed("path outside the listed directory"))?;
        result.push(relative.to_string());
    }
    Ok(result)
}

fn text(value: &str) -> Result<String, CandidateError> {
    String::from_utf8(decode(value)?).map_err(|_| malformed("non-UTF-8 file"))
}

/// Paths the receipt's `files` checksum list names, relative to the root.
fn receipt_files(listing: &str) -> BTreeSet<String> {
    listing
        .lines()
        .filter_map(|line| line.split_once("  ").map(|(_, path)| path))
        .filter_map(|path| path.strip_prefix('/'))
        .map(str::to_string)
        .collect()
}

fn parents(path: &str) -> impl Iterator<Item = &str> {
    path.match_indices('/')
        .map(move |(index, _)| &path[..index])
}

/// Evaluate a verifier's raw inventory. `images` lists the image IDs the base may contain.
pub fn evaluate(report: &str, images: &[String]) -> Result<Inventory, CandidateError> {
    let raw = parse(report)?;
    let flag = |key: &str| -> Result<bool, CandidateError> {
        match field(&raw, key)? {
            "0" => Ok(false),
            "1" => Ok(true),
            _ => Err(malformed(key)),
        }
    };
    let mut unexpected = Vec::new();
    for name in paths(field(&raw, "storage_top")?)? {
        if !STORAGE_TOP.contains(&name.as_str()) {
            unexpected.push(format!("storage:{name}"));
        }
    }
    for (dir, value) in &raw.storage_dirs {
        for path in paths(value)? {
            unexpected.push(format!("storage:{dir}/{path}"));
        }
    }
    for name in paths(field(&raw, "docker_top")?)? {
        if !DOCKER_TOP.contains(&name.as_str()) && name != "engine-id" {
            unexpected.push(format!("storage:docker/{name}"));
        }
    }
    for path in paths(field(&raw, "docker_network")?)? {
        unexpected.push(format!("storage:docker/network/{path}"));
    }
    let containers = paths(field(&raw, "docker_containers")?)?.len();
    let volumes = paths(field(&raw, "docker_volumes")?)?
        .iter()
        .filter(|name| !VOLUME_BOOKKEEPING.contains(&name.as_str()))
        .count();
    let found_images = paths(field(&raw, "images")?)?;
    for image in &found_images {
        if !images.iter().any(|allowed| allowed == image) {
            unexpected.push(format!("image:{image}"));
        }
    }
    let tools_files = text(field(&raw, "tools_files")?)?;
    let package_files = receipt_files(&tools_files);
    let mut allowed_dirs: BTreeSet<&str> = UPPER_DIRS.into_iter().collect();
    for path in package_files
        .iter()
        .map(String::as_str)
        .chain(TOOLS_UPPER_FILES)
        .chain(UPPER_FILES)
        .chain(UPPER_LINKS)
        .chain(UPPER_DIRS)
    {
        allowed_dirs.extend(parents(path));
    }
    for path in paths(field(&raw, "upper_files")?)? {
        if !package_files.contains(&path)
            && !TOOLS_UPPER_FILES.contains(&path.as_str())
            && !UPPER_FILES.contains(&path.as_str())
        {
            unexpected.push(format!("overlay:{path}"));
        }
    }
    for path in paths(field(&raw, "upper_links")?)? {
        // Package symlinks are named by the receipt; their targets are checked by `sha256sum -c`.
        if !package_files.contains(&path) && !UPPER_LINKS.contains(&path.as_str()) {
            unexpected.push(format!("overlay-link:{path}"));
        }
    }
    for path in paths(field(&raw, "upper_dirs")?)? {
        if !allowed_dirs.contains(path.as_str()) && !provider_mount_point(&path) {
            unexpected.push(format!("overlay-dir:{path}"));
        }
    }
    for path in paths(field(&raw, "upper_other")?)? {
        unexpected.push(format!("overlay-special:{path}"));
    }
    unexpected.sort();
    Ok(Inventory {
        owner_marker_present: flag("owner_marker")?,
        engine_id_present: flag("engine_id")?,
        containers: u32::try_from(containers).unwrap_or(u32::MAX),
        volumes: u32::try_from(volumes).unwrap_or(u32::MAX),
        network_tools_owner: text(field(&raw, "tools_owner")?)?,
        network_tools_identity: text(field(&raw, "tools_identity")?)?,
        network_tools_files_verified: match field(&raw, "tools_check")? {
            "ok" => true,
            "failed" => false,
            _ => return Err(malformed("tools_check")),
        },
        images: found_images,
        unexpected,
    })
}

#[cfg(test)]
mod tests;
