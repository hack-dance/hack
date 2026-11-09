//! Native source content limit.
//!
//! Content capture reads every selected file into memory to bind a source revision,
//! so the selected (non-ignored) project content is bounded. The bound defaults to
//! 128 MiB and a project can raise it with `native.sourceLimitMiB` in its committed
//! `.hack/hack.config.json`, up to [`MAXIMUM_LIMIT_MIB`]. The limit is an admission
//! threshold only: it never enters plan identity or a content revision.
//!
//! [`report`] measures the same selection capture reads without reading file contents,
//! so callers can refuse an oversized project before runtime, image or build work.
use super::{problem, source};
use crate::CandidateError;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CString;
use std::fs::File;
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::path::Path;

const MIB: u64 = 1024 * 1024;
/// Capture limit when the project configures none.
pub const DEFAULT_LIMIT_BYTES: u64 = 128 * MIB;
/// Largest configurable limit. Capture holds the selected content and its archive in
/// memory at once, so peak runtime memory is roughly twice the limit.
pub const MAXIMUM_LIMIT_MIB: u64 = 512;
pub const MAXIMUM_LIMIT_BYTES: u64 = MAXIMUM_LIMIT_MIB * MIB;
/// Project configuration larger than this is not read for the limit.
const CONFIG_MAX_BYTES: u64 = 1024 * 1024;
const REPORTED_PATHS: usize = 5;
/// Directories are summarized at the first two levels, where an ignore entry is useful.
const DIRECTORY_DEPTH: usize = 2;

fn invalid_limit() -> CandidateError {
    problem(
        "source_limit_config",
        "native.sourceLimitMiB in .hack/hack.config.json must be a whole number of MiB from 1 to 512.",
    )
}

fn open_at(parent: &File, name: &str, directory: bool) -> Option<File> {
    let name = CString::new(name).ok()?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    // SAFETY: `parent` owns a valid descriptor for this call and `name` is a
    // NUL-terminated string that outlives it; the returned descriptor is owned below.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    // SAFETY: a non-negative descriptor was just returned to this process and
    // is owned by nothing else.
    (fd >= 0).then(|| unsafe { File::from_raw_fd(fd) })
}

/// Read the configured limit from `<project>/.hack/hack.config.json`.
///
/// Returns `None` when no regular, bounded, parseable configuration declares the
/// setting: an absent, aliased or malformed file keeps the default, and the CLI's own
/// configuration checks report malformed files. A declared value that is not a whole
/// number of MiB from 1 to [`MAXIMUM_LIMIT_MIB`] refuses. Components are opened without
/// following symlinks.
pub fn configured_limit(project: &Path) -> Result<Option<u64>, CandidateError> {
    let Ok(root) = File::open(project) else {
        return Ok(None);
    };
    let Some(directory) = open_at(&root, ".hack", true) else {
        return Ok(None);
    };
    let Some(mut file) = open_at(&directory, "hack.config.json", false) else {
        return Ok(None);
    };
    let Ok(metadata) = file.metadata() else {
        return Ok(None);
    };
    if !metadata.is_file() || metadata.len() > CONFIG_MAX_BYTES {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    if Read::by_ref(&mut file)
        .take(CONFIG_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > CONFIG_MAX_BYTES
    {
        return Ok(None);
    }
    let Ok(config) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Ok(None);
    };
    let Some(value) = config.get("native").and_then(|n| n.get("sourceLimitMiB")) else {
        return Ok(None);
    };
    let mib = value
        .as_u64()
        .filter(|mib| (1..=MAXIMUM_LIMIT_MIB).contains(mib))
        .ok_or_else(invalid_limit)?;
    Ok(Some(mib * MIB))
}

/// The limit a plan's capture enforces: the configured value, else the default.
/// A retained value above the maximum is clamped rather than trusted.
pub fn effective_limit(configured: Option<u64>) -> u64 {
    configured.map_or(DEFAULT_LIMIT_BYTES, |bytes| bytes.min(MAXIMUM_LIMIT_BYTES))
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SizedPath {
    /// Project-relative path.
    pub path: String,
    pub bytes: u64,
}

/// Size of the selected project content, measured from metadata only.
#[derive(Debug, Serialize)]
pub struct Report {
    pub schema_version: u32,
    pub kind: &'static str,
    /// Selected regular-file bytes; capture also adds small generated placeholders.
    pub total_bytes: u64,
    pub file_count: usize,
    pub limit_bytes: u64,
    /// `project` when `.hack/hack.config.json` sets `native.sourceLimitMiB`.
    pub limit_origin: &'static str,
    pub maximum_limit_bytes: u64,
    pub within_limit: bool,
    pub largest_files: Vec<SizedPath>,
    /// Largest directories at the first two levels, by selected file bytes.
    pub largest_directories: Vec<SizedPath>,
}

fn largest(sizes: impl Iterator<Item = (String, u64)>) -> Vec<SizedPath> {
    let mut sizes: Vec<_> = sizes
        .filter(|(_, bytes)| *bytes > 0)
        .map(|(path, bytes)| SizedPath { path, bytes })
        .collect();
    sizes.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.path.cmp(&b.path)));
    sizes.truncate(REPORTED_PATHS);
    sizes
}

/// Measure the selection capture would read, using the project's ignore rules and the
/// fixed credential/generated exclusions. Compose `env_file` inputs are not known here,
/// so a declared env file outside those exclusions is counted (they are small).
/// The inventory budget (20,000 entries, 10 seconds) still applies.
pub fn report(project: &Path) -> Result<Report, CandidateError> {
    let configured = configured_limit(project)?;
    let limit_bytes = effective_limit(configured);
    let mut diagnostics = Vec::new();
    let selection = source::inventory(project, &BTreeSet::new(), &mut diagnostics)?;
    let files: Vec<_> = selection
        .entries
        .iter()
        .filter(|entry| entry.kind == "file")
        .collect();
    let total_bytes = files
        .iter()
        .try_fold(0_u64, |total, entry| total.checked_add(entry.bytes))
        .ok_or_else(|| problem("source_budget", "Source size overflowed."))?;
    let mut directories = BTreeMap::<String, u64>::new();
    for entry in &files {
        let parts: Vec<_> = entry.path.split('/').collect();
        for depth in 1..parts.len().min(DIRECTORY_DEPTH + 1) {
            *directories.entry(parts[..depth].join("/")).or_default() += entry.bytes;
        }
    }
    Ok(Report {
        schema_version: 1,
        kind: "native_source_size",
        total_bytes,
        file_count: files.len(),
        limit_bytes,
        limit_origin: if configured.is_some() {
            "project"
        } else {
            "default"
        },
        maximum_limit_bytes: MAXIMUM_LIMIT_BYTES,
        within_limit: total_bytes <= limit_bytes,
        largest_files: largest(files.iter().map(|e| (e.path.clone(), e.bytes))),
        largest_directories: largest(directories.into_iter()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture(name: &str) -> Fixture {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-source-budget-{name}-{}-{}",
            std::process::id(),
            crate::next_test_scratch()
        ));
        fs::create_dir_all(root.join(".hack")).unwrap();
        Fixture(root)
    }
    fn configure(project: &Path, text: &str) {
        fs::write(project.join(".hack/hack.config.json"), text).unwrap();
    }

    #[test]
    fn limit_defaults_and_accepts_only_whole_mib_up_to_the_maximum() {
        let project = fixture("limit");
        assert_eq!(configured_limit(&project.0).unwrap(), None);
        configure(&project.0, "{\"name\":\"app\"}");
        assert_eq!(configured_limit(&project.0).unwrap(), None);
        configure(&project.0, "not json");
        assert_eq!(configured_limit(&project.0).unwrap(), None);
        configure(&project.0, "{\"native\":{\"sourceLimitMiB\":256}}");
        assert_eq!(configured_limit(&project.0).unwrap(), Some(256 * MIB));
        configure(&project.0, "{\"native\":{\"sourceLimitMiB\":512}}");
        assert_eq!(
            configured_limit(&project.0).unwrap(),
            Some(MAXIMUM_LIMIT_BYTES)
        );
        for value in ["0", "513", "1.5", "-1", "\"256\"", "null"] {
            configure(
                &project.0,
                &format!("{{\"native\":{{\"sourceLimitMiB\":{value}}}}}"),
            );
            assert_eq!(
                configured_limit(&project.0).unwrap_err().code,
                "source_limit_config",
                "{value}"
            );
        }
        assert_eq!(effective_limit(None), DEFAULT_LIMIT_BYTES);
        assert_eq!(effective_limit(Some(u64::MAX)), MAXIMUM_LIMIT_BYTES);
    }

    #[test]
    fn aliased_configuration_is_not_followed() {
        let project = fixture("alias");
        let outside = fixture("alias-outside");
        configure(&outside.0, "{\"native\":{\"sourceLimitMiB\":300}}");
        std::os::unix::fs::symlink(
            outside.0.join(".hack/hack.config.json"),
            project.0.join(".hack/hack.config.json"),
        )
        .unwrap();
        assert_eq!(configured_limit(&project.0).unwrap(), None);
    }

    #[test]
    fn report_sizes_selected_content_and_names_the_largest_paths() {
        let project = fixture("report");
        let root = &project.0;
        fs::create_dir_all(root.join("assets/video")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("ignored")).unwrap();
        fs::write(root.join("assets/video/intro.bin"), vec![0_u8; 3000]).unwrap();
        fs::write(root.join("assets/logo.bin"), vec![0_u8; 500]).unwrap();
        fs::write(root.join("src/app.ts"), vec![0_u8; 100]).unwrap();
        fs::write(root.join("ignored/blob.bin"), vec![0_u8; 9000]).unwrap();
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        fs::write(root.join(".env"), "SECRET=1\n").unwrap();
        let report = report(root).unwrap();
        let ignore_bytes = fs::metadata(root.join(".gitignore")).unwrap().len();
        assert_eq!(report.total_bytes, 3600 + ignore_bytes);
        assert_eq!(report.file_count, 4);
        assert_eq!(report.limit_bytes, DEFAULT_LIMIT_BYTES);
        assert_eq!(report.limit_origin, "default");
        assert!(report.within_limit);
        assert_eq!(
            report.largest_files[0],
            SizedPath {
                path: "assets/video/intro.bin".into(),
                bytes: 3000
            }
        );
        assert_eq!(
            report.largest_directories[..2],
            [
                SizedPath {
                    path: "assets".into(),
                    bytes: 3500
                },
                SizedPath {
                    path: "assets/video".into(),
                    bytes: 3000
                },
            ]
        );
        assert!(
            report
                .largest_files
                .iter()
                .chain(&report.largest_directories)
                .all(|p| !p.path.starts_with("ignored") && p.path != ".env")
        );
    }

    #[test]
    fn plan_carries_the_limit_outside_identity_and_capture_enforces_it() {
        let project = fixture("plan");
        let checkout = fixture("plan-candidate");
        let candidate = crate::Candidate::discover(&checkout.0).unwrap();
        fs::write(
            project.0.join(".hack/compose.yml"),
            "services:\n  web:\n    image: alpine:3.21\n",
        )
        .unwrap();
        fs::write(project.0.join("blob.bin"), vec![0_u8; (2 * MIB) as usize]).unwrap();
        let review = || {
            super::super::plan(
                &candidate,
                super::super::PlanOptions {
                    project: &project.0,
                    branch: None,
                    compose_file: Path::new(".hack/compose.yml"),
                    profiles: &[],
                },
            )
            .unwrap()
        };
        configure(&project.0, r#"{"native":{"sourceLimitMiB":1}}"#);
        let small = review();
        assert_eq!(small.plan.source_limit_bytes, Some(MIB));
        let mut unconfigured = small.plan.clone();
        unconfigured.source_limit_bytes = None;
        assert_eq!(
            super::super::identity(&unconfigured).unwrap(),
            small.plan_id,
            "the limit never changes plan identity"
        );
        let refused = super::super::snapshot::capture_plan(&small.plan);
        assert_eq!(refused.err().expect("over limit").code, "source_budget");
        configure(&project.0, r#"{"native":{"sourceLimitMiB":4}}"#);
        let large = review();
        assert_eq!(large.plan.source_limit_bytes, Some(4 * MIB));
        let snapshot = super::super::snapshot::capture_plan(&large.plan).unwrap();
        assert!(snapshot.receipt().total_bytes > 2 * MIB);
    }

    #[test]
    fn report_uses_the_configured_limit() {
        let project = fixture("configured");
        configure(&project.0, "{\"native\":{\"sourceLimitMiB\":1}}");
        fs::write(project.0.join("blob.bin"), vec![0_u8; (MIB + 1) as usize]).unwrap();
        let report = report(&project.0).unwrap();
        assert_eq!(report.limit_bytes, MIB);
        assert_eq!(report.limit_origin, "project");
        assert!(!report.within_limit);
    }
}
