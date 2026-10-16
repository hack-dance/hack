use super::{Diagnostic, problem};
use crate::CandidateError;
use caseless::Caseless;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};
use unicode_normalization::UnicodeNormalization;

const MAX_ENTRIES: usize = 20_000;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct SourceEntry {
    pub path: String,
    pub kind: String,
    pub bytes: u64,
    pub modified_nanos: u64,
    pub executable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
}

pub(super) fn folded_name(text: &str) -> String {
    text.chars().nfd().default_case_fold().nfd().collect()
}

pub(super) fn link_destination(path: &Path, target: &Path) -> Option<PathBuf> {
    if target.is_absolute() {
        return None;
    }
    let mut normalized = path.parent()?.to_owned();
    for part in target.components() {
        match part {
            Component::Normal(value) => normalized.push(value),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            _ => return None,
        }
    }
    (!normalized.as_os_str().is_empty()).then_some(normalized)
}

/// Directory traversal includes both real child edges and directory aliases.
pub(super) fn acyclic_directories<'a>(
    entries: impl Iterator<Item = (&'a str, &'a str, Option<&'a str>)>,
) -> bool {
    let entries: Vec<_> = entries.collect();
    let mut edges = BTreeMap::<String, Vec<String>>::new();
    edges.insert(String::new(), Vec::new());
    for (path, kind, _) in &entries {
        if *kind == "directory" {
            edges.entry((*path).into()).or_default();
        }
    }
    for (path, kind, target) in entries {
        let parent = Path::new(path)
            .parent()
            .and_then(Path::to_str)
            .unwrap_or("");
        let destination = if kind == "directory" {
            Some(path.to_owned())
        } else {
            target
                .and_then(|t| link_destination(Path::new(path), Path::new(t)))
                .and_then(|p| p.to_str().map(str::to_owned))
                .filter(|p| edges.contains_key(p))
        };
        if let Some(destination) = destination {
            let Some(children) = edges.get_mut(parent) else {
                return false;
            };
            children.push(destination);
        }
    }
    let mut incoming: BTreeMap<_, usize> = edges.keys().map(|p| (p.clone(), 0)).collect();
    for destination in edges.values().flatten() {
        *incoming
            .get_mut(destination)
            .expect("directory destination") += 1;
    }
    let mut ready: Vec<_> = incoming
        .iter()
        .filter(|(_, n)| **n == 0)
        .map(|(p, _)| p.clone())
        .collect();
    let mut visited = 0;
    while let Some(path) = ready.pop() {
        visited += 1;
        for destination in &edges[&path] {
            let count = incoming
                .get_mut(destination)
                .expect("directory destination");
            *count -= 1;
            if *count == 0 {
                ready.push(destination.clone());
            }
        }
    }
    visited == edges.len()
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct SourceSelection {
    pub policy: String,
    pub identity_kind: String,
    pub metadata_sha256: String,
    pub ignore_files: BTreeMap<String, String>,
    pub entries: Vec<SourceEntry>,
    pub excluded_paths: Vec<String>,
    pub exclusion_rules: Vec<String>,
}

pub fn excluded(path: &Path) -> bool {
    let parts: Vec<_> = path
        .components()
        .filter_map(|p| p.as_os_str().to_str())
        .collect();
    for (index, part) in parts.iter().enumerate() {
        let lower = part.to_ascii_lowercase();
        if [
            ".git",
            ".worktrees",
            ".delta",
            ".ai",
            ".hack-local",
            ".hack-v5-private",
            "node_modules",
            "target",
            "dist",
            ".next",
            ".turbo",
            "coverage",
            ".cache",
            ".aws",
            ".ssh",
            ".gnupg",
            ".config",
            ".codex",
            ".claude",
            ".agents",
            "secrets",
            "credentials",
        ]
        .contains(&lower.as_str())
            || lower.starts_with(".env")
            || lower.starts_with("hack.env")
            || [
                ".npmrc",
                ".netrc",
                ".pypirc",
                "auth.json",
                "credentials.json",
                "service-account.json",
                "id_rsa",
                "id_ed25519",
            ]
            .contains(&lower.as_str())
            || [".pem", ".key", ".p12", ".pfx"]
                .iter()
                .any(|suffix| lower.ends_with(suffix))
            || (index > 0 && parts[index - 1] == ".hack" && [".internal", ".branch"].contains(part))
        {
            return true;
        }
    }
    false
}

/// Resolve a declared source inside the project without following any symlink component.
/// Compose-relative paths use the directory containing the explicitly selected Compose file.
pub fn resolve(
    project: &Path,
    base: &Path,
    value: &str,
    allow_credentials: bool,
) -> Result<PathBuf, CandidateError> {
    if value.is_empty() || value.contains('$') || value.contains('\0') || value.contains('~') {
        return Err(problem(
            "unresolved_source_path",
            "Source paths must be literal paths inside the selected project.",
        ));
    }
    let input = Path::new(value);
    let mut resolved = if input.is_absolute() {
        PathBuf::new()
    } else {
        base.to_owned()
    };
    for component in input.components() {
        match component {
            Component::ParentDir => {
                if !resolved.pop() {
                    return Err(problem("source_escape", "Source path escapes the project."));
                }
            }
            Component::CurDir => {}
            part => resolved.push(part.as_os_str()),
        }
    }
    if !resolved.starts_with(project) {
        return Err(problem(
            "source_escape",
            "Host paths outside the project are not enrolled.",
        ));
    }
    let relative = resolved.strip_prefix(project).expect("checked prefix");
    if !allow_credentials && excluded(relative) {
        return Err(problem(
            "excluded_source",
            "Declared source is excluded by the credential/generated-state policy.",
        ));
    }
    let mut current = project.to_owned();
    for part in relative.components() {
        current.push(part);
        let metadata = fs::symlink_metadata(&current).map_err(|_| {
            problem(
                "missing_source",
                "Declared source does not exist or cannot be inspected.",
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(problem(
                "source_symlink",
                "Declared source must not follow symlinks.",
            ));
        }
    }
    Ok(resolved)
}

pub fn read_compose(path: &Path) -> Result<Vec<u8>, CandidateError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| {
            problem(
                "compose_unavailable",
                "Cannot open the selected Compose file.",
            )
        })?;
    let before = file
        .metadata()
        .map_err(|_| problem("compose_unavailable", "Cannot inspect Compose input."))?;
    if !before.is_file() || before.nlink() != 1 || before.len() > super::yaml::MAX_BYTES as u64 {
        return Err(problem(
            "invalid_compose_file",
            "Compose input must be a singly linked regular file no larger than 256 KiB.",
        ));
    }
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(super::yaml::MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| problem("compose_unavailable", "Cannot read Compose input."))?;
    let after = file
        .metadata()
        .map_err(|_| problem("compose_unavailable", "Cannot inspect Compose input."))?;
    if bytes.len() > super::yaml::MAX_BYTES
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
    {
        return Err(problem(
            "compose_changed",
            "Compose input changed while planning; retry from stable input.",
        ));
    }
    Ok(bytes)
}

fn rules(
    directory: &Path,
    project: &Path,
    hashes: &mut BTreeMap<String, String>,
) -> Result<Option<Arc<ignore::gitignore::Gitignore>>, CandidateError> {
    let mut builder = ignore::gitignore::GitignoreBuilder::new(directory);
    let mut found = false;
    for name in [".gitignore", ".ignore"] {
        let path = directory.join(name);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err(problem(
                    "invalid_ignore_rules",
                    "Cannot inspect project ignore rules.",
                ));
            }
            Ok(_) => {}
        }
        // Unlike an automatic walker, this does not open ignore-file symlinks or read
        // rules inside already excluded credential/dependency directories.
        let bytes=read_compose(&path).map_err(|_| problem("invalid_ignore_rules","Ignore rules must be stable, bounded, singly linked regular files; aliases are not read."))?;
        if bytes.len() > 64 * 1024 {
            return Err(problem("source_budget", "An ignore file exceeds 64 KiB."));
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| problem("invalid_ignore_rules", "Ignore rules must be UTF-8."))?;
        for line in text.lines() {
            builder.add_line(Some(path.clone()), line).map_err(|_| {
                problem(
                    "invalid_ignore_rules",
                    "Invalid ignore pattern; source text is omitted.",
                )
            })?;
        }
        hashes.insert(
            path.strip_prefix(project)
                .expect("project rule")
                .to_string_lossy()
                .into_owned(),
            format!("{:x}", Sha256::digest(&bytes)),
        );
        found = true;
    }
    if found {
        Ok(Some(Arc::new(builder.build().map_err(|_| {
            problem(
                "invalid_ignore_rules",
                "Cannot compile project ignore rules.",
            )
        })?)))
    } else {
        Ok(None)
    }
}

pub fn inventory(
    project: &Path,
    environment_files: &BTreeSet<String>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<SourceSelection, CandidateError> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut stack = vec![(
        project.to_owned(),
        Vec::<Arc<ignore::gitignore::Gitignore>>::new(),
        0_usize,
    )];
    let mut entries = Vec::new();
    let mut excluded_paths = Vec::new();
    let mut folded = BTreeSet::new();
    let mut ignore_files = BTreeMap::new();
    let mut visited = 0;
    let mut path_bytes = 0;
    while let Some((directory, mut matchers, depth)) = stack.pop() {
        if depth >= 64 {
            return Err(problem(
                "source_budget",
                "Source directory depth exceeds 64.",
            ));
        }
        if let Some(rules) = rules(&directory, project, &mut ignore_files)? {
            matchers.push(rules);
        }
        let children = fs::read_dir(&directory)
            .map_err(|_| problem("source_unavailable", "Cannot read source directory."))?;
        for child in children {
            visited += 1;
            if visited > MAX_ENTRIES || Instant::now() > deadline {
                return Err(problem(
                    "source_budget",
                    "Source inventory exceeds the 20,000-entry / 10-second planning budget.",
                ));
            }
            let child =
                child.map_err(|_| problem("source_changed", "Source changed during inventory."))?;
            let full = child.path();
            let path = full.strip_prefix(project).expect("source child");
            let text = path.to_str().ok_or_else(|| {
                problem(
                    "unsupported_source_name",
                    "Source names must be valid UTF-8.",
                )
            })?;
            if excluded(path) || environment_files.contains(text) {
                excluded_paths.push(text.to_owned());
                continue;
            }
            let metadata = fs::symlink_metadata(&full)
                .map_err(|_| problem("source_changed", "Source changed during inventory."))?;
            let mut ignored = false;
            for matcher in &matchers {
                let matched = matcher.matched(&full, metadata.is_dir());
                if matched.is_ignore() {
                    ignored = true;
                } else if matched.is_whitelist() {
                    ignored = false;
                }
            }
            if ignored {
                excluded_paths.push(text.to_owned());
                continue;
            }
            if text.chars().any(char::is_control) {
                return Err(problem(
                    "unsupported_source_name",
                    "Source names must be printable UTF-8 without control characters.",
                ));
            }
            path_bytes += text.len();
            if path_bytes > 2 * 1024 * 1024 {
                return Err(problem(
                    "source_budget",
                    "Source path inventory exceeds 2 MiB.",
                ));
            }
            if !folded.insert(folded_name(text)) {
                diagnostics.push(Diagnostic::error(
                    "source_case_collision",
                    "source",
                    "Source paths collide under Unicode canonical normalization and case folding.",
                ));
            }
            let mut link_target = None;
            let kind = if metadata.file_type().is_symlink() {
                let target = fs::read_link(&full).map_err(|_| {
                    problem("source_changed", "Source link changed during inventory.")
                })?;
                if let Some(target_text) =
                    target.to_str().filter(|s| !s.chars().any(char::is_control))
                {
                    if link_destination(path, &target).is_some() {
                        link_target = Some(target_text.to_owned());
                    }
                }
                if link_target.is_none() {
                    diagnostics.push(Diagnostic::error(
                        "source_symlink",
                        "source",
                        "Only relative symlinks to selected source entries can be captured.",
                    ));
                }
                "symlink"
            } else if metadata.is_dir() {
                stack.push((full.clone(), matchers.clone(), depth + 1));
                "directory"
            } else if metadata.is_file() {
                if metadata.nlink() != 1 {
                    diagnostics.push(Diagnostic::error("source_hardlink", "source", "Multiply linked source files are not enrolled; their other paths are outside this source view."));
                }
                "file"
            } else {
                diagnostics.push(Diagnostic::error(
                    "special_source_file",
                    "source",
                    "Devices, sockets and other special files are not source inputs.",
                ));
                "special"
            };
            let modified = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .and_then(|d| u64::try_from(d.as_nanos()).ok())
                .ok_or_else(|| {
                    problem(
                        "source_metadata_unavailable",
                        "Cannot establish source modification time.",
                    )
                })?;
            entries.push(SourceEntry {
                path: text.to_owned(),
                kind: kind.into(),
                bytes: metadata.len(),
                modified_nanos: modified,
                executable: kind != "symlink" && metadata.mode() & 0o111 != 0,
                link_target,
            });
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let kinds: BTreeMap<_, _> = entries
        .iter()
        .map(|e| (e.path.as_str(), e.kind.as_str()))
        .collect();
    for entry in &entries {
        if let Some(target) = &entry.link_target {
            let destination =
                link_destination(Path::new(&entry.path), Path::new(target)).expect("checked link");
            let allowed = destination
                .to_str()
                .and_then(|p| kinds.get(p))
                .is_some_and(|kind| ["file", "directory"].contains(kind))
                && destination
                    .ancestors()
                    .skip(1)
                    .all(|p| p.to_str().and_then(|p| kinds.get(p)) != Some(&"symlink"));
            if !allowed {
                diagnostics.push(Diagnostic::error("source_symlink", "source", "Link targets must be selected regular files or directories; credential/ignored targets, chains and cycles are refused."));
            }
        }
    }
    if !acyclic_directories(
        entries
            .iter()
            .map(|e| (e.path.as_str(), e.kind.as_str(), e.link_target.as_deref())),
    ) {
        diagnostics.push(Diagnostic::error(
            "source_symlink",
            "source",
            "Directory aliases create a recursive traversal cycle.",
        ));
    }
    excluded_paths.sort();
    let bytes = serde_json::to_vec(&(&entries, &ignore_files, &excluded_paths))
        .map_err(|_| problem("serialization_failed", "Cannot encode source inventory."))?;
    Ok(SourceSelection {
        policy:"project-local .gitignore/.ignore rules plus fixed and env_file credential exclusions; no global ignore rules".into(),
        identity_kind:"path/type/size/mtime/executable metadata plus ignore-rule identity; NOT a content revision or synchronized snapshot".into(),
        metadata_sha256:format!("{:x}",Sha256::digest(bytes)),ignore_files,entries,excluded_paths,
        exclusion_rules:vec!["known credential paths, .env*, hack.env* and every declared env_file input".into(),"generated builds/dependencies, nested .worktrees and candidate/provider state".into(),"Git and agent-local configuration directories".into(),"project .gitignore/.ignore rules, including tracked files they exclude".into()],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collision_keys_include_unicode_normalization_and_expanding_case_folds() {
        assert_eq!(folded_name("src/café"), folded_name("src/cafe\u{301}"));
        assert_eq!(folded_name("src/Straße"), folded_name("src/STRASSE"));
        assert_ne!(folded_name("src/資料"), folded_name("src/other"));
    }

    #[test]
    fn directory_alias_graph_rejects_ancestry_and_mutual_cycles() {
        assert!(!acyclic_directories(
            [
                ("a", "directory", None),
                ("a/loop", "symlink", Some("../a"))
            ]
            .into_iter()
        ));
        assert!(!acyclic_directories(
            [
                ("a", "directory", None),
                ("b", "directory", None),
                ("a/to-b", "symlink", Some("../b")),
                ("b/to-a", "symlink", Some("../a"))
            ]
            .into_iter()
        ));
        assert!(acyclic_directories(
            [
                ("a", "directory", None),
                ("b", "directory", None),
                ("a/to-b", "symlink", Some("../b"))
            ]
            .into_iter()
        ));
    }
}
