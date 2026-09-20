//! Bounded content generations. File bytes are never part of debug or JSON receipts.
mod generated;
mod mountpoints;
mod registry;
use super::{Diagnostic, SourceSelection, problem, source};
use crate::CandidateError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path};

const MAX_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContentEntry {
    pub path: String,
    pub kind: String,
    pub executable: bool,
    pub bytes: u64,
    pub sha256: Option<String>,
    pub link_target: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct ContentRevision {
    pub schema_version: u32,
    pub revision: String,
    pub selection_sha256: String,
    pub total_bytes: u64,
    pub entries: Vec<ContentEntry>,
}

#[derive(Debug, Serialize)]
pub struct Delta {
    pub from_revision: Option<String>,
    pub to_revision: String,
    pub changed_paths: BTreeSet<String>,
    /// Deepest paths first, so replacing a directory cannot hide its children.
    pub removed_entries: Vec<ContentEntry>,
    pub transferred_file_bytes: u64,
}

impl ContentRevision {
    pub fn validate(&self) -> Result<(), CandidateError> {
        let invalid = || {
            problem(
                "invalid_source_manifest",
                "Source manifest identity, paths or limits are invalid.",
            )
        };
        if self.schema_version != 1 || self.entries.len() > 20_000 || self.total_bytes > MAX_BYTES {
            return Err(invalid());
        }
        if self
            .entries
            .windows(2)
            .any(|pair| pair[0].path >= pair[1].path)
        {
            return Err(invalid());
        }
        let mut paths = BTreeMap::new();
        let mut folded = BTreeSet::new();
        let mut total = 0_u64;
        for entry in &self.entries {
            let path = Path::new(&entry.path);
            if path
                .components()
                .map(|p| p.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
                != entry.path
            {
                return Err(invalid());
            }
            if entry.path.is_empty()
                || entry.path.len() > 4096
                || entry.path.chars().any(char::is_control)
                || path
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_)))
                || paths.insert(entry.path.as_str(), entry).is_some()
                || !folded.insert(source::folded_name(&entry.path))
            {
                return Err(invalid());
            }
            match entry.kind.as_str() {
                "file"
                    if entry.link_target.is_none()
                        && entry.sha256.as_ref().is_some_and(|sha| {
                            sha.len() == 64
                                && sha
                                    .bytes()
                                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                        }) => {}
                "directory"
                    if entry.link_target.is_none()
                        && entry.sha256.is_none()
                        && entry.bytes == 0 => {}
                "symlink"
                    if entry.link_target.is_some()
                        && entry.sha256.is_none()
                        && entry.bytes == 0 => {}
                _ => return Err(invalid()),
            }
            total = total.checked_add(entry.bytes).ok_or_else(invalid)?;
        }
        for entry in &self.entries {
            let path = Path::new(&entry.path);
            for parent in path
                .ancestors()
                .skip(1)
                .filter(|p| !p.as_os_str().is_empty())
            {
                if paths
                    .get(parent.to_str().ok_or_else(invalid)?)
                    .is_none_or(|e| e.kind != "directory")
                {
                    return Err(invalid());
                }
            }
            if let Some(target) = &entry.link_target {
                if target.chars().any(char::is_control) {
                    return Err(invalid());
                }
                let destination =
                    source::link_destination(path, Path::new(target)).ok_or_else(invalid)?;
                if paths
                    .get(destination.to_str().ok_or_else(invalid)?)
                    .is_none_or(|e| !["file", "directory"].contains(&e.kind.as_str()))
                {
                    return Err(invalid());
                }
            }
        }
        if !source::acyclic_directories(
            self.entries
                .iter()
                .map(|e| (e.path.as_str(), e.kind.as_str(), e.link_target.as_deref())),
        ) {
            return Err(invalid());
        }
        let encoded = serde_json::to_vec(&(1_u32, &self.entries)).map_err(|_| invalid())?;
        if total != self.total_bytes || format!("{:x}", Sha256::digest(encoded)) != self.revision {
            return Err(invalid());
        }
        Ok(())
    }
}

pub struct Snapshot {
    receipt: ContentRevision,
    // Kept private so diagnostics cannot accidentally serialize source contents.
    files: Vec<Vec<u8>>,
}

impl Snapshot {
    pub fn receipt(&self) -> &ContentRevision {
        &self.receipt
    }

    pub fn files(&self) -> impl Iterator<Item = (&ContentEntry, &[u8])> {
        self.receipt
            .entries
            .iter()
            .zip(self.files.iter().map(Vec::as_slice))
    }

    pub fn delta(&self, previous: Option<&ContentRevision>) -> Delta {
        let old: BTreeMap<_, _> = previous
            .into_iter()
            .flat_map(|r| &r.entries)
            .map(|entry| (entry.path.as_str(), entry))
            .collect();
        let new: BTreeMap<_, _> = self
            .receipt
            .entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry))
            .collect();
        let changed_paths: BTreeSet<_> = new
            .iter()
            .filter(|(path, entry)| old.get(**path) != Some(*entry))
            .map(|(path, _)| (*path).to_owned())
            .collect();
        let mut removed_entries: Vec<_> = old
            .iter()
            .filter(|(path, entry)| new.get(**path).is_none_or(|next| next.kind != entry.kind))
            .map(|(_, entry)| (*entry).clone())
            .collect();
        removed_entries.sort_by(|a, b| {
            b.path
                .split('/')
                .count()
                .cmp(&a.path.split('/').count())
                .then(b.path.cmp(&a.path))
        });
        let transferred_file_bytes = self
            .receipt
            .entries
            .iter()
            .filter(|entry| changed_paths.contains(&entry.path))
            .map(|entry| entry.bytes)
            .sum();
        Delta {
            from_revision: previous.map(|r| r.revision.clone()),
            to_revision: self.receipt.revision.clone(),
            changed_paths,
            removed_entries,
            transferred_file_bytes,
        }
    }

    pub fn archive(&self) -> Result<Vec<u8>, CandidateError> {
        self.archive_selected(None)
    }

    pub fn delta_archive(&self, delta: &Delta) -> Result<Vec<u8>, CandidateError> {
        if delta.to_revision != self.receipt.revision {
            return Err(problem(
                "source_revision_mismatch",
                "Delta belongs to a different captured revision.",
            ));
        }
        self.archive_selected(Some(&delta.changed_paths))
    }

    fn archive_selected(
        &self,
        paths: Option<&BTreeSet<String>>,
    ) -> Result<Vec<u8>, CandidateError> {
        let mut archive = tar::Builder::new(Vec::new());
        for (entry, bytes) in self.files() {
            if paths.is_some_and(|paths| !paths.contains(&entry.path)) {
                continue;
            }
            let mut header = tar::Header::new_gnu();
            let directory = entry.kind == "directory";
            header.set_entry_type(if directory {
                tar::EntryType::Directory
            } else {
                tar::EntryType::Regular
            });
            header.set_size(bytes.len() as u64);
            header.set_mode(if directory || entry.executable {
                0o755
            } else {
                0o644
            });
            header.set_uid(0);
            header.set_gid(0);
            header.set_mtime(0);
            if let Some(target) = &entry.link_target {
                header.set_entry_type(tar::EntryType::Symlink);
                archive
                    .append_link(&mut header, &entry.path, target)
                    .map_err(|_| {
                        problem("source_archive", "Cannot encode captured source link.")
                    })?;
                continue;
            }
            archive
                .append_data(&mut header, &entry.path, bytes)
                .map_err(|_| problem("source_archive", "Cannot encode captured source archive."))?;
        }
        archive
            .into_inner()
            .map_err(|_| problem("source_archive", "Cannot finish captured source archive."))
    }
}

/// Traverse using directory descriptors: replacing any ancestor with a symlink cannot
/// redirect a read into host credential directories. The final fd is checked before reading.
fn open_entry(root: &File, path: &Path, directory: bool) -> Result<File, CandidateError> {
    let mut parent = root.try_clone().map_err(|_| changed())?;
    let components: Vec<_> = path.components().collect();
    if components.is_empty() {
        return Err(changed());
    }
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(changed());
        };
        let name = CString::new(name.as_encoded_bytes()).map_err(|_| changed())?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if index + 1 < components.len() || directory {
                libc::O_DIRECTORY
            } else {
                0
            };
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(changed());
        }
        parent = unsafe { File::from_raw_fd(fd) };
    }
    Ok(parent)
}

fn changed() -> CandidateError {
    problem(
        "source_changed",
        "Source changed or became unsafe during capture; no generation was accepted.",
    )
}

fn link_text(root: &File, path: &Path) -> Result<String, CandidateError> {
    let parent_path = path.parent().ok_or_else(changed)?;
    let parent = if parent_path.as_os_str().is_empty() {
        root.try_clone().map_err(|_| changed())?
    } else {
        open_entry(root, parent_path, true)?
    };
    let name = CString::new(path.file_name().ok_or_else(changed)?.as_encoded_bytes())
        .map_err(|_| changed())?;
    let mut target = [0_u8; 4096];
    let n = unsafe {
        libc::readlinkat(
            parent.as_raw_fd(),
            name.as_ptr(),
            target.as_mut_ptr().cast(),
            target.len(),
        )
    };
    if n < 0 || n as usize == target.len() {
        return Err(changed());
    }
    std::str::from_utf8(&target[..n as usize])
        .map(str::to_owned)
        .map_err(|_| changed())
}

fn selection(
    project: &Path,
    environment_files: &BTreeSet<String>,
) -> Result<SourceSelection, CandidateError> {
    let mut diagnostics = Vec::<Diagnostic>::new();
    let selection = source::inventory(project, environment_files, &mut diagnostics)?;
    if diagnostics.iter().any(|d| d.severity == "error") {
        return Err(problem(
            "unsafe_source",
            "Source selection contains aliases, special files or conflicting names; no content was read.",
        ));
    }
    Ok(selection)
}

/// Capture the reviewed graph artifact, including excluded mountpoint skeletons
/// and value-free registry templates. A stale review is refused by capture.
pub fn capture_plan(plan: &super::PlanData) -> Result<Snapshot, CandidateError> {
    let environment_files = plan
        .services
        .values()
        .flat_map(|service| service.environment_files.iter().cloned())
        .collect();
    capture(
        &plan.source,
        &environment_files,
        &plan.source_selection.metadata_sha256,
    )?
    .with_mountpoints(plan)?
    .with_registry(plan)?
    .with_generated(plan)
}

/// Capture only an explicitly reviewed selection. The returned content is independent of
/// later edits; a second inventory rejects detected additions, deletions and ignore changes.
/// This is not an atomic filesystem snapshot of concurrently modified source.
pub fn capture(
    project: &Path,
    environment_files: &BTreeSet<String>,
    expected_selection: &str,
) -> Result<Snapshot, CandidateError> {
    let selected = selection(project, environment_files)?;
    if selected.metadata_sha256 != expected_selection {
        return Err(changed());
    }
    let root = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(project)
        .map_err(|_| changed())?;
    let mut entries = Vec::new();
    let mut files = Vec::new();
    let mut total = 0_u64;
    for entry in &selected.entries {
        let directory = entry.kind == "directory";
        if let Some(target) = &entry.link_target {
            if link_text(&root, Path::new(&entry.path))? != *target {
                return Err(changed());
            }
            entries.push(ContentEntry {
                path: entry.path.clone(),
                kind: "symlink".into(),
                executable: false,
                bytes: 0,
                sha256: None,
                link_target: Some(target.clone()),
            });
            files.push(Vec::new());
            continue;
        }
        let mut file = open_entry(&root, Path::new(&entry.path), directory)?;
        let before = file.metadata().map_err(|_| changed())?;
        let mut bytes = Vec::new();
        if !directory {
            if !before.is_file() || before.nlink() != 1 || before.len() != entry.bytes {
                return Err(changed());
            }
            let remaining = MAX_BYTES
                .checked_sub(total)
                .ok_or_else(|| problem("source_budget", "Source content exceeds 128 MiB."))?;
            if before.len() > remaining {
                return Err(problem("source_budget", "Source content exceeds 128 MiB."));
            }
            Read::by_ref(&mut file)
                .take(remaining + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| changed())?;
            let after = file.metadata().map_err(|_| changed())?;
            if bytes.len() as u64 != before.len()
                || before.len() != after.len()
                || before.mtime() != after.mtime()
                || before.mtime_nsec() != after.mtime_nsec()
                || before.ctime() != after.ctime()
                || before.ctime_nsec() != after.ctime_nsec()
                || after.nlink() != 1
            {
                return Err(changed());
            }
            total += bytes.len() as u64;
        }
        entries.push(ContentEntry {
            path: entry.path.clone(),
            kind: entry.kind.clone(),
            executable: entry.executable,
            bytes: bytes.len() as u64,
            sha256: (!directory).then(|| format!("{:x}", Sha256::digest(&bytes))),
            link_target: None,
        });
        files.push(bytes);
    }
    if selection(project, environment_files)?.metadata_sha256 != selected.metadata_sha256 {
        return Err(changed());
    }
    let encoded = serde_json::to_vec(&(1_u32, &entries))
        .map_err(|_| problem("serialization_failed", "Cannot encode source revision."))?;
    Ok(Snapshot {
        receipt: ContentRevision {
            schema_version: 1,
            revision: format!("{:x}", Sha256::digest(encoded)),
            selection_sha256: selected.metadata_sha256,
            total_bytes: total,
            entries,
        },
        files,
    })
}
