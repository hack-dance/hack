//! Typed `hack files --json` boundary for one Compose service.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::runner::{CliRunner, RunError};

const SCHEMA: &str = "hack.files.v1";
const READ_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub root: PathBuf,
    pub branch: Option<String>,
    pub compose_project: String,
    pub service: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Read {
    List,
    Cat,
}

impl Read {
    fn arg(self) -> &'static str {
        match self {
            Self::List => "ls",
            Self::Cat => "cat",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileSource {
    Worktree,
    Container,
    Volume,
}

impl FileSource {
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Worktree => "worktree",
            Self::Container => "container",
            Self::Volume => "volume",
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: Kind,
    pub source: FileSource,
    pub host_path: Option<PathBuf>,
    pub size_bytes: Option<u64>,
    pub modified_at_ms: i64,
}

impl Entry {
    /// Compare the selected entry with a fresh CLI read before opening it.
    /// Retargeted mounts, links or paths outside this checkout cannot be opened.
    ///
    /// # Errors
    /// The mapping changed or the mapped file is unavailable.
    pub fn editor_path(&self, current: &Self, root: &Path) -> Result<PathBuf, &'static str> {
        if self.path != current.path
            || self.host_path != current.host_path
            || current.source != FileSource::Worktree
            || current.kind != Kind::File
        {
            return Err("The service's worktree mount changed. Refresh Files and try again.");
        }
        const MISSING: &str = "This file is no longer available in the worktree.";
        let path = self.host_path.as_ref().ok_or(MISSING)?;
        let root = root.canonicalize().map_err(|_| MISSING)?;
        let actual = path.canonicalize().map_err(|_| MISSING)?;
        if actual == *path && actual.starts_with(root) && actual.is_file() {
            Ok(actual)
        } else {
            Err(MISSING)
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Encoding {
    Utf8,
    Base64,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "lowercase")]
pub enum Report {
    #[serde(rename = "ls")]
    List { entry: Entry, entries: Vec<Entry> },
    Cat {
        entry: Entry,
        encoding: Encoding,
        content: String,
        truncated: bool,
    },
}

#[derive(Deserialize)]
struct Reply {
    service: String,
    #[serde(flatten)]
    report: Report,
}

/// Invoke the pinned CLI, with the service and path passed as positional argv.
///
/// # Errors
/// The CLI refused the read or replied with an invalid schema, service or operation.
pub(crate) fn read(
    runner: &CliRunner,
    target: &Target,
    op: Read,
    path: &str,
) -> Result<Report, String> {
    let mut args = vec!["files", op.arg(), "--json", "--no-interactive"];
    if let Some(branch) = &target.branch {
        crate::source::validate_branch(branch)
            .map_err(|_| "Invalid branch instance name.".to_owned())?;
        args.extend(["--branch", branch]);
    }
    args.extend(["--expect-compose-project", &target.compose_project]);
    args.extend(["--", &target.service, path]);
    let reply: Reply = runner
        .run_schema_json(&args, Some(&target.root), READ_TIMEOUT, SCHEMA)
        .map_err(|error| match error {
            RunError::BadJson { .. } => {
                "The selected Hack CLI did not return a Files report.".into()
            }
            _ => error.to_string(),
        })?;
    let matches = matches!(
        (op, &reply.report),
        (Read::List, Report::List { .. }) | (Read::Cat, Report::Cat { .. })
    );
    if reply.service != target.service || !matches {
        return Err("The Files report is for a different request.".into());
    }
    Ok(reply.report)
}
