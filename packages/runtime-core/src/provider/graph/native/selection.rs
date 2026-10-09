//! Exact native authored input selection for an explicit candidate/project namespace.
//! No authored parsing, credential acquisition, Git commands or provider mutation.
use crate::{
    Candidate, CandidateError,
    project::native,
    provider::{native_input, private_deadline::Deadline},
};
use hack_config_compiler::environment::{EnvMetadata, EnvPlanRequest};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, Metadata, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Instant,
};

mod hooks;

const LIMIT: usize = 1024 * 1024;

fn refused() -> CandidateError {
    CandidateError::new(
        "native_graph_selection",
        "Native execution requires an exact unchanged native input family in unredirected directories; linked-worktree local inheritance is not yet qualified. Values omitted.",
    )
}

#[derive(Clone, PartialEq, Eq)]
struct Identity {
    device: u64,
    inode: u64,
}
impl Identity {
    fn of(metadata: &Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
}
#[derive(Clone, PartialEq, Eq)]
struct Content {
    identity: Identity,
    size: u64,
    modified: (i64, i64),
    changed: (i64, i64),
    mode: u32,
    links: u64,
}
impl Content {
    fn of(metadata: &Metadata) -> Self {
        Self {
            identity: Identity::of(metadata),
            size: metadata.len(),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
            changed: (metadata.ctime(), metadata.ctime_nsec()),
            mode: metadata.mode(),
            links: metadata.nlink(),
        }
    }
}
#[derive(Clone, PartialEq, Eq)]
struct Document {
    content: Content,
    digest: [u8; 32],
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum SourceKind {
    NativeGraphSource,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Overlay {
    #[default]
    Inherit,
    Base,
    Named(String),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceInput {
    version: u32,
    kind: SourceKind,
    project: PathBuf,
    #[serde(default)]
    branch: Option<String>,
    run: String,
    #[serde(default)]
    profiles: Vec<String>,
    #[serde(default)]
    overlay: Overlay,
    env_metadata: EnvMetadata,
    #[serde(default)]
    hook_permit: Option<hooks::Pin>,
}
/// Tagged public native-source selection, with no Compose or private-value fields.
pub struct Source {
    path: PathBuf,
    snapshot: Document,
    input: SourceInput,
    hooks: Option<hooks::Permit>,
}
impl Source {
    /// Read a stable, bounded, unaliased regular envelope; authored selection remains compiler-owned.
    pub fn read(path: &Path) -> Result<Self, CandidateError> {
        Self::read_kind(path, None)
    }
    /// Explicit frontend action only; ordinary plan/run/serve never admit host intent.
    pub fn read_frontend(path: &Path, execution: bool) -> Result<Self, CandidateError> {
        Self::read_kind(path, Some(execution))
    }
    fn read_kind(path: &Path, execution: Option<bool>) -> Result<Self, CandidateError> {
        if !path.is_absolute() {
            return Err(refused());
        }
        let (snapshot, text) = document(path, true)?;
        let text = text.ok_or_else(refused)?;
        let raw: serde_json::Value = serde_json::from_str(&text).map_err(|_| refused())?;
        let input: SourceInput = serde_json::from_str(&text).map_err(|_| refused())?;
        if input.version != if execution.is_some() { 3 } else { 2 }
            || (execution.is_none() && raw.get("hook_permit").is_some())
            || !matches!(input.kind, SourceKind::NativeGraphSource)
            || !super::hex(&input.run, 32)
        {
            return Err(refused());
        }
        let hooks = execution
            .map(|execution| hooks::Permit::read(path, &input, execution))
            .transpose()?;
        Ok(Self {
            hooks,
            path: path.into(),
            snapshot: snapshot.ok_or_else(refused)?,
            input,
        })
    }
    pub fn run_id(&self) -> &str {
        &self.input.run
    }
    /// Retain the envelope snapshot alongside compiler-owned authored selection and deadline.
    pub fn select(
        self,
        candidate: &Candidate,
        deadline: Instant,
    ) -> Result<Selected, CandidateError> {
        let explicit_overlay = match self.input.overlay {
            Overlay::Inherit => None,
            Overlay::Base => Some(None),
            Overlay::Named(name) => Some(Some(name)),
        };
        let mut selected = select_frontend(
            candidate,
            Options {
                project: &self.input.project,
                branch: self.input.branch.as_deref(),
                run: &self.input.run,
                profiles: &self.input.profiles,
                explicit_overlay,
                metadata: self.input.env_metadata,
                deadline,
            },
            self.hooks,
        )?;
        selected.source = Some((self.path, self.snapshot));
        selected.assert_fresh(candidate)?;
        Ok(selected)
    }
}

fn directory(path: &Path) -> Result<Identity, CandidateError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| refused())?;
    if !metadata.is_dir() || path.canonicalize().map_err(|_| refused())? != path {
        return Err(refused());
    }
    Ok(Identity::of(&metadata))
}
fn optional_metadata(path: &Path) -> Result<Option<Metadata>, CandidateError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(refused()),
    }
}
fn family(root: &Path) -> Result<(), CandidateError> {
    directory(root)?;
    directory(&root.join(".hack"))?;
    if optional_metadata(&root.join(".dev"))?.is_some() {
        directory(&root.join(".dev"))?;
    }
    for dirname in [".hack", ".dev"] {
        for filename in ["docker-compose.yml", "hack.config.json", "hack.toml"] {
            if optional_metadata(&root.join(dirname).join(filename))?.is_some() {
                return Err(refused());
            }
        }
    }
    Ok(())
}
fn document(
    path: &Path,
    required: bool,
) -> Result<(Option<Document>, Option<String>), CandidateError> {
    let Some(observed) = optional_metadata(path)? else {
        return if required {
            Err(refused())
        } else {
            Ok((None, None))
        };
    };
    if !observed.is_file()
        || observed.len() == 0
        || observed.len() > LIMIT as u64
        || observed.nlink() != 1
        || observed.mode() & 0o444 == 0
    {
        return Err(refused());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| refused())?;
    let before = file.metadata().map_err(|_| refused())?;
    let content = Content::of(&before);
    if !before.is_file() || content != Content::of(&observed) {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    let after = file.metadata().map_err(|_| refused())?;
    let current = fs::symlink_metadata(path).map_err(|_| refused())?;
    if bytes.len() as u64 != before.len()
        || content != Content::of(&after)
        || !current.is_file()
        || content != Content::of(&current)
    {
        return Err(refused());
    }
    let digest = Sha256::digest(&bytes).into();
    let text = String::from_utf8(bytes).map_err(|_| refused())?;
    Ok((Some(Document { content, digest }), Some(text)))
}

#[derive(Clone, PartialEq, Eq)]
enum GitMarker {
    Absent,
    Directory(Identity),
    Linked(Content),
}
fn git_marker(root: &Path) -> Result<GitMarker, CandidateError> {
    let path = root.join(".git");
    match optional_metadata(&path)? {
        None => Ok(GitMarker::Absent),
        Some(metadata) if metadata.is_dir() => Ok(GitMarker::Directory(directory(&path)?)),
        Some(metadata)
            if metadata.is_file() && metadata.nlink() == 1 && metadata.len() <= LIMIT as u64 =>
        {
            Ok(GitMarker::Linked(Content::of(&metadata)))
        }
        Some(_) => Err(refused()),
    }
}

struct Bounded(Vec<u8>);
impl Write for Bounded {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self
            .0
            .len()
            .checked_add(bytes.len())
            .is_none_or(|n| n > hack_config_compiler::local::MAX_REQUEST_BYTES)
        {
            return Err(std::io::Error::other("native request budget"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub struct Options<'a> {
    /// Exact absolute project root; no ancestor discovery or legacy fallback.
    pub project: &'a Path,
    pub branch: Option<&'a str>,
    pub run: &'a str,
    pub profiles: &'a [String],
    pub explicit_overlay: Option<Option<String>>,
    /// Public metadata acquired by its existing managed-env owner; never private values.
    pub metadata: EnvMetadata,
    /// Original ingress deadline, before authored selection and private preparation.
    pub deadline: Instant,
}

/// Opaque, ephemeral authored selection. No Debug/Serialize or raw request getter.
pub struct Selected {
    pub(super) project_source: Option<super::source::Selection>,
    source: Option<(PathBuf, Document)>,
    hooks: Option<hooks::Permit>,
    candidate_root: PathBuf,
    root: PathBuf,
    branch: Option<String>,
    root_identity: Identity,
    hack_identity: Identity,
    project: Document,
    local: Option<Document>,
    git: GitMarker,
    request: Vec<u8>,
    profiles: Vec<String>,
    review: native_input::Review,
    deadline: Deadline,
}
/// Value-free authored input fence retained by the live owner for read-only control.
/// Its lifetime is the owner lifetime; this does not renew a startup deadline.
pub(super) struct ReadPin {
    source: Option<(PathBuf, Document)>,
    candidate_root: PathBuf,
    root: PathBuf,
    branch: Option<String>,
    root_identity: Identity,
    hack_identity: Identity,
    project: Document,
    local: Option<Document>,
    git: GitMarker,
    review: native_input::Review,
}
impl ReadPin {
    pub(super) fn verify(&self, candidate: &Candidate) -> Result<(), CandidateError> {
        if let Some((path, snapshot)) = &self.source {
            if document(path, true)?.0.as_ref() != Some(snapshot) {
                return Err(refused());
            }
        }
        family(&self.root)?;
        let workspace = candidate
            .plan_with_branch(&self.root, self.branch.as_deref())
            .map_err(|_| refused())?;
        if candidate.state_root != self.candidate_root
            || workspace.source != self.root
            || workspace.namespace != self.review.scope().namespace
            || directory(&self.root)? != self.root_identity
            || directory(&self.root.join(".hack"))? != self.hack_identity
            || document(&self.root.join(".hack/hack.project.json"), true)?
                .0
                .as_ref()
                != Some(&self.project)
            || document(&self.root.join(".hack/hack.local.json"), false)?.0 != self.local
            || git_marker(&self.root)? != self.git
        {
            return Err(refused());
        }
        family(&self.root)?;
        if directory(&self.root)? != self.root_identity
            || directory(&self.root.join(".hack"))? != self.hack_identity
        {
            return Err(refused());
        }
        Ok(())
    }
}
impl Selected {
    fn read_pin(&self) -> ReadPin {
        ReadPin {
            source: self.source.clone(),
            candidate_root: self.candidate_root.clone(),
            root: self.root.clone(),
            branch: self.branch.clone(),
            root_identity: self.root_identity.clone(),
            hack_identity: self.hack_identity.clone(),
            project: self.project.clone(),
            local: self.local.clone(),
            git: self.git.clone(),
            review: self.review.clone(),
        }
    }
    pub fn review(&self) -> &native_input::Review {
        &self.review
    }
    pub fn project_root(&self) -> &Path {
        &self.root
    }
    pub fn remaining(&self) -> Result<Instant, CandidateError> {
        self.deadline.to_instant()
    }
    /// Shorten the existing ingress deadline after bounded private descriptor consumption.
    /// A later supplied deadline cannot renew this selection.
    pub fn restrict_deadline(&mut self, deadline: Instant) -> Result<(), CandidateError> {
        self.deadline = Deadline::from_instant(self.remaining()?.min(deadline))?;
        Ok(())
    }
    /// Read-only recheck; no atomic multi-file snapshot or editor exclusion is claimed.
    pub fn assert_fresh(&self, candidate: &Candidate) -> Result<(), CandidateError> {
        self.remaining()?;
        if let Some(source) = &self.project_source {
            source.verify()?;
        }
        self.read_pin().verify(candidate)?;
        if let Some(hooks) = &self.hooks {
            hooks.verify()?;
        }
        self.remaining()?;
        Ok(())
    }
    /// Fresh compile plus private preparation. This does not stage a guest or grant ownership.
    pub fn prepare(
        self,
        candidate: &Candidate,
        values: &native::ManagedValues,
    ) -> Result<Prepared, CandidateError> {
        self.assert_fresh(candidate)?;
        let options = native_input::PrepareOptions {
            compile: native::CompileOptions {
                request: &self.request,
                profiles: &self.profiles,
                managed_values: values,
            },
            scope: self.review.scope(),
            expected_review: &self.review,
            deadline: self.remaining()?,
        };
        let prepared = if let Some(hooks) = &self.hooks {
            native_input::prepare_frontend(options, &hooks.capability())?
        } else {
            native_input::prepare(options)?
        };
        self.assert_fresh(candidate)?;
        Ok(Prepared {
            selected: self,
            prepared,
        })
    }
}
/// Selected authored input and private preparation share the original deadline.
pub struct Prepared {
    selected: Selected,
    prepared: native_input::Prepared,
}
impl Prepared {
    pub(super) fn read_pin(&self) -> ReadPin {
        self.selected.read_pin()
    }
    pub fn assert_fresh(&self, candidate: &Candidate) -> Result<(), CandidateError> {
        self.selected.assert_fresh(candidate)?;
        self.prepared.remaining()?;
        Ok(())
    }
    pub fn input(&self) -> &native_input::Prepared {
        &self.prepared
    }
    pub fn remaining(&self) -> Result<Instant, CandidateError> {
        self.prepared.remaining()
    }
    /// Transfer the live selection capability along with private preparation;
    /// consumers must keep checking selection/deadline before effects.
    pub fn into_parts(
        self,
        candidate: &Candidate,
    ) -> Result<(Selected, native_input::Prepared), CandidateError> {
        self.assert_fresh(candidate)?;
        Ok((self.selected, self.prepared))
    }
}

pub fn select(candidate: &Candidate, options: Options<'_>) -> Result<Selected, CandidateError> {
    select_frontend(candidate, options, None)
}
fn select_frontend(
    candidate: &Candidate,
    options: Options<'_>,
    hooks: Option<hooks::Permit>,
) -> Result<Selected, CandidateError> {
    let deadline = Deadline::from_instant(options.deadline)?;
    if !super::hex(options.run, 32)
        || options.profiles.len() > 64
        || options.profiles.iter().any(|profile| {
            profile.is_empty() || profile.len() > 256 || profile.chars().any(char::is_control)
        })
    {
        return Err(refused());
    }
    let root = options.project;
    if !root.is_absolute()
        || root
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(refused());
    }
    family(root)?;
    let root_identity = directory(root)?;
    let hack_identity = directory(&root.join(".hack"))?;
    let workspace = candidate
        .plan_with_branch(root, options.branch)
        .map_err(|_| refused())?;
    if workspace.source != root {
        return Err(refused());
    }
    let (project, text) = document(&root.join(".hack/hack.project.json"), true)?;
    let (local, checkout_local) = document(&root.join(".hack/hack.local.json"), false)?;
    let git = git_marker(root)?;
    let mut writer = Bounded(Vec::new());
    serde_json::to_writer(
        &mut writer,
        &EnvPlanRequest {
            request_version: 1,
            project: text.ok_or_else(refused)?,
            primary_local: None,
            checkout_local,
            explicit_overlay: options.explicit_overlay,
            global_domain: None,
            explicit_domain: None,
            branch: options.branch.map(str::to_owned),
            env_metadata: options.metadata,
        },
    )
    .map_err(|_| refused())?;
    let inputs = if let Some(hooks) = &hooks {
        hooks.verify()?;
        native::review_frontend(&writer.0, options.profiles, &hooks.capability())?
    } else {
        native::review_inputs(&writer.0, options.profiles)?
    };
    if matches!(git, GitMarker::Linked(_)) && inputs.local_resolution.inherit_local {
        return Err(refused());
    }
    let review = native_input::Review::new(
        native_input::Scope {
            namespace: &workspace.namespace,
            run: options.run,
        },
        inputs.review_identity(),
    )?;
    let selected = Selected {
        project_source: super::source::Selection::new(root, &inputs)?,
        hooks,
        source: None,
        candidate_root: candidate.state_root.clone(),
        root: root.to_owned(),
        branch: options.branch.map(str::to_owned),
        root_identity,
        hack_identity,
        project: project.ok_or_else(refused)?,
        local,
        git,
        request: writer.0,
        profiles: options.profiles.to_owned(),
        review,
        deadline,
    };
    selected.assert_fresh(candidate)?;
    Ok(selected)
}

#[cfg(test)]
mod tests;
