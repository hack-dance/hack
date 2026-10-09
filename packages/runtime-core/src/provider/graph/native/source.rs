//! Host-mounted intent uses only an already-approved live virtiofs share.
//! Host edits are allowed. Path/permission checks detect replacement; they do
//! not lock host editors or make the shared tree an atomic snapshot.
use super::*;
use crate::{project::native::SourceMount, provider::ProjectShareIntent};
use std::{
    ffi::CString,
    fs::{File, Metadata, OpenOptions},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path},
    time::Instant,
};

// Fixed POSIX stat-mode fields in the Darwin/Linux receipt wire. The host libc
// mode_t width differs between those platforms; the serialized field is u32.
const MODE_TYPE: u32 = 0o170000;
const MODE_DIRECTORY: u32 = 0o040000;
const MODE_FILE: u32 = 0o100000;

fn refused() -> CandidateError {
    error(
        "native_graph_source",
        "Native host-mounted source requires its unchanged selected path and permissions, an already-approved exact live project share and read-only guest bind; values omitted.",
    )
}
fn relative(value: &str) -> bool {
    value == "."
        || (!value.is_empty()
            && value.len() <= 4096
            && !value.chars().any(char::is_control)
            && Path::new(value)
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
            && Path::new(value)
                .components()
                .map(|p| p.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
                == value)
}
fn absolute(value: &str) -> bool {
    value.len() <= 4096
        && value.starts_with('/')
        && !value.chars().any(char::is_control)
        && Path::new(value)
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
        && format!(
            "/{}",
            Path::new(value)
                .components()
                .filter_map(|c| match c {
                    Component::Normal(name) => name.to_str(),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("/")
        ) == value
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Anchor {
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub kind: String,
}
impl Anchor {
    fn read(metadata: &Metadata) -> Result<Self, CandidateError> {
        // SAFETY: geteuid has no caller preconditions.
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o022 != 0
            || !(metadata.is_dir() || metadata.is_file())
            || (metadata.is_file() && (metadata.nlink() != 1 || metadata.mode() & 0o400 == 0))
            || (metadata.is_dir() && metadata.mode() & 0o500 != 0o500)
        {
            return Err(refused());
        }
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            mode: metadata.mode(),
            uid: metadata.uid(),
            gid: metadata.gid(),
            kind: if metadata.is_dir() {
                "directory"
            } else {
                "file"
            }
            .into(),
        })
    }
    fn valid(&self) -> bool {
        self.inode > 0
            && self.inode <= 9_007_199_254_740_991
            && self.device <= 9_007_199_254_740_991
            && self.mode <= 0xffff
            && self.mode & 0o022 == 0
            && match self.kind.as_str() {
                "directory" => {
                    self.mode & MODE_TYPE == MODE_DIRECTORY && self.mode & 0o500 == 0o500
                }
                "file" => self.mode & MODE_TYPE == MODE_FILE && self.mode & 0o400 != 0,
                _ => false,
            }
    }
}

/// Content, mtimes and directory entry counts are deliberately absent. A selected
/// regular file may be edited in place; a selected directory permits descendant edits.
pub(super) struct Selection {
    root: PathBuf,
    mounts: BTreeMap<String, SourceMount>,
    anchors: BTreeMap<String, Anchor>,
}
fn selected_paths(
    mounts: &BTreeMap<String, SourceMount>,
) -> Result<BTreeSet<String>, CandidateError> {
    let mut paths = BTreeSet::from([".".into()]);
    if mounts.is_empty() || mounts.len() > MAX_SERVICES {
        return Err(refused());
    }
    for mount in mounts.values() {
        if !relative(&mount.source) || !absolute(&mount.target) {
            return Err(refused());
        }
        if mount.source != "." {
            for path in Path::new(&mount.source)
                .ancestors()
                .filter(|p| !p.as_os_str().is_empty())
            {
                paths.insert(path.to_str().ok_or_else(refused)?.into());
            }
        }
    }
    Ok(paths)
}
fn capture(
    root: &Path,
    mounts: &BTreeMap<String, SourceMount>,
) -> Result<BTreeMap<String, Anchor>, CandidateError> {
    crate::reject_aliased_state(root).map_err(|_| refused())?;
    let root_file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_DIRECTORY)
        .open(root)
        .map_err(|_| refused())?;
    let root_anchor = Anchor::read(&root_file.metadata().map_err(|_| refused())?)?;
    let mut anchors = BTreeMap::from([(".".into(), root_anchor)]);
    for source in selected_paths(mounts)?.iter().filter(|p| p.as_str() != ".") {
        crate::project::resolve_source(root, root, source, false).map_err(|_| refused())?;
        let mut parent = root_file.try_clone().map_err(|_| refused())?;
        let components: Vec<_> = Path::new(source).components().collect();
        for (index, component) in components.iter().enumerate() {
            let Component::Normal(name) = component else {
                return Err(refused());
            };
            let name = CString::new(name.as_encoded_bytes()).map_err(|_| refused())?;
            let flags = libc::O_RDONLY
                | libc::O_NOFOLLOW
                | libc::O_NONBLOCK
                | libc::O_CLOEXEC
                | if index + 1 < components.len() {
                    libc::O_DIRECTORY
                } else {
                    0
                };
            // SAFETY: parent is an owned open directory; the name is a NUL-terminated
            // single component. The successful descriptor is transferred exactly once.
            let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0 {
                return Err(refused());
            }
            // SAFETY: openat returned a fresh descriptor owned by this scope.
            parent = unsafe { File::from_raw_fd(fd) };
        }
        let anchor = Anchor::read(&parent.metadata().map_err(|_| refused())?)?;
        let named = Anchor::read(&fs::symlink_metadata(root.join(source)).map_err(|_| refused())?)?;
        if anchor != named {
            return Err(refused());
        }
        anchors.insert(source.clone(), anchor);
    }
    for (path, expected) in &anchors {
        let path = if path == "." {
            root.into()
        } else {
            root.join(path)
        };
        // The shared state helper admits directories only. A selected regular
        // file has a separately verified no-follow descriptor and named inode;
        // apply the helper to its parent chain rather than rejecting the file.
        let directories = if expected.kind == "file" {
            path.parent().ok_or_else(refused)?
        } else {
            &path
        };
        crate::reject_aliased_state(directories).map_err(|_| refused())?;
        if *expected != Anchor::read(&fs::symlink_metadata(path).map_err(|_| refused())?)? {
            return Err(refused());
        }
    }
    Ok(anchors)
}
impl Selection {
    pub(super) fn new(root: &Path, inputs: &NativeInputs) -> Result<Option<Self>, CandidateError> {
        let mounts: BTreeMap<_, _> = inputs
            .workloads
            .iter()
            .filter_map(|(name, workload)| {
                workload
                    .source_mount
                    .as_ref()
                    .map(|mount| (name.clone(), mount.clone()))
            })
            .collect();
        if mounts.is_empty() {
            return Ok(None);
        }
        Ok(Some(Self {
            root: root.into(),
            anchors: capture(root, &mounts)?,
            mounts,
        }))
    }
    pub(super) fn verify(&self) -> Result<(), CandidateError> {
        if capture(&self.root, &self.mounts)? != self.anchors {
            return Err(refused());
        }
        Ok(())
    }
    pub(super) fn bind(&self, share: &ProjectShareIntent) -> Result<Binding, CandidateError> {
        share.validate_receipt().map_err(|_| refused())?;
        if share.project != self.root
            || share.device != self.anchors["."].device
            || share.inode != self.anchors["."].inode
        {
            return Err(refused());
        }
        self.verify()?;
        Ok(Binding {
            version: 1,
            policy: "host-mounted".into(),
            share: share.clone(),
            mounts: self.mounts.clone(),
            anchors: self.anchors.clone(),
        })
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Binding {
    pub version: u32,
    pub policy: String,
    pub share: ProjectShareIntent,
    pub mounts: BTreeMap<String, SourceMount>,
    pub anchors: BTreeMap<String, Anchor>,
}
impl Binding {
    pub(super) fn validate(
        &self,
        services: &BTreeMap<String, Condition>,
    ) -> Result<(), CandidateError> {
        self.share.validate_receipt().map_err(|_| refused())?;
        let paths = selected_paths(&self.mounts)?;
        let root = self.anchors.get(".").ok_or_else(refused)?;
        if self.version != 1
            || self.policy != "host-mounted"
            || self.mounts.keys().any(|name| !services.contains_key(name))
            || self.anchors.keys().ne(paths.iter())
            || self
                .anchors
                .values()
                .any(|a| !a.valid() || a.uid != root.uid)
            || root.kind != "directory"
            || root.device != self.share.device
            || root.inode != self.share.inode
            || paths.iter().any(|path| {
                path != "."
                    && self
                        .mounts
                        .values()
                        .any(|m| m.source.starts_with(&format!("{path}/")))
                    && self.anchors[path].kind != "directory"
            })
        {
            return Err(refused());
        }
        Ok(())
    }
    pub(super) fn path(&self, service: &str) -> Result<String, CandidateError> {
        let mount = self.mounts.get(service).ok_or_else(refused)?;
        Ok(if mount.source == "." {
            self.share.guest_path.clone()
        } else {
            format!("{}/{}", self.share.guest_path, mount.source)
        })
    }
    pub(super) fn config(&self, service: &str) -> Result<Value, CandidateError> {
        let mount = self.mounts.get(service).ok_or_else(refused)?;
        Ok(
            json!({"Type":"bind","Source":self.path(service)?,"Target":mount.target,"ReadOnly":true,"BindOptions":{"Propagation":"rprivate"}}),
        )
    }
    pub(super) fn verify_host(&self) -> Result<(), CandidateError> {
        if capture(&self.share.project, &self.mounts)? != self.anchors {
            return Err(refused());
        }
        Ok(())
    }
    pub(super) fn verify_container(
        &self,
        service: &str,
        value: &Value,
    ) -> Result<(), CandidateError> {
        let Some(mount) = self.mounts.get(service) else {
            return Ok(());
        };
        let configs = value["HostConfig"]["Mounts"]
            .as_array()
            .ok_or_else(refused)?;
        let configured: Vec<_> = configs
            .iter()
            .filter(|m| m["Target"].as_str() == Some(&mount.target))
            .collect();
        if configured.len() != 1
            || super::super::mismatch(&self.config(service)?, configured[0], "Mounts").is_some()
        {
            return Err(refused());
        }
        let mounts = value["Mounts"].as_array().ok_or_else(refused)?;
        // Docker can retain only the exact configured bind before its first start.
        // A nonempty runtime mount must always match; exited/running containers do
        // not inherit this created-only allowance.
        if mounts.is_empty()
            && value["State"]["Status"] == "created"
            && value["State"]["Running"] == false
        {
            return Ok(());
        }
        let selected: Vec<_> = mounts
            .iter()
            .filter(|m| m["Destination"].as_str() == Some(&mount.target))
            .collect();
        if selected.len() != 1
            || selected[0]["Type"] != "bind"
            || selected[0]["Source"] != self.path(service)?
            || selected[0]["RW"] != false
            || selected[0]["Propagation"] != "rprivate"
        {
            return Err(refused());
        }
        Ok(())
    }
}

pub(super) fn prepare(
    engine: &Engine<'_>,
    selected: &Selection,
) -> Result<Binding, CandidateError> {
    selected.verify()?;
    let share = engine.guest().project_share().ok_or_else(refused)?;
    share.validate().map_err(|_| refused())?;
    let binding = selected.bind(share)?;
    verify(engine, &binding, true)?;
    Ok(binding)
}

/// Cleanup verifies the original approved pool share and read-only container bind,
/// without following/adopting a moved or deleted host source. Startup/status also
/// require the selected live host path and guest path to remain safe.
pub(super) fn verify(
    engine: &Engine<'_>,
    binding: &Binding,
    active: bool,
) -> Result<(), CandidateError> {
    verify_using(engine, binding, active, None)
}

/// Finite observations share their original deadline with every guest query.
pub(super) fn verify_until(
    engine: &Engine<'_>,
    binding: &Binding,
    deadline: Instant,
) -> Result<(), CandidateError> {
    verify_using(engine, binding, true, Some(deadline))
}

fn verify_using(
    engine: &Engine<'_>,
    binding: &Binding,
    active: bool,
    deadline: Option<Instant>,
) -> Result<(), CandidateError> {
    if let Some(deadline) = deadline {
        crate::provider::managed_environment::remaining_until(deadline)?;
    }
    if engine.guest().project_share() != Some(&binding.share) {
        return Err(refused());
    }
    if active {
        binding.verify_host()?;
    }
    if let Some(deadline) = deadline {
        super::super::source::verify_shared_mount_until(engine, &binding.share, deadline)?;
    } else if active {
        super::super::source::verify_shared_mount(engine, &binding.share)?;
    } else {
        super::super::source::verify_shared_mount_cleanup(engine, &binding.share)?;
    }
    if active {
        for name in binding.mounts.keys() {
            let path = binding.path(name)?;
            let kind = &binding.anchors[&binding.mounts[name].source].kind;
            let script = "set -eu; test \"$(realpath -e -- \"$1\")\" = \"$1\"; if test \"$2\" = directory; then test -d \"$1\"; else test \"$2\" = file; test -f \"$1\"; fi";
            if let Some(deadline) = deadline {
                engine
                    .guest()
                    .execute_until(script, &[&path, kind], deadline)?;
            } else {
                engine.guest().execute(script, &[&path, kind], None)?;
            }
        }
        binding.verify_host()?;
    }
    engine.guest().verify()?;
    if let Some(deadline) = deadline {
        crate::provider::managed_environment::remaining_until(deadline)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
