//! Checkout-local v5 candidate contracts and experimental private runtime lifecycle.
//! Project planning remains read-only; provider commands are explicit and separately qualified.

pub mod node;
pub mod project;
pub mod provider;

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const PROTOCOL_VERSION: u32 = 1;
pub const CANDIDATE_VERSION: &str = "5.0.0-dev.6";

mod error;
pub use error::CandidateError;

#[derive(Debug, Serialize)]
pub struct Candidate {
    pub protocol_version: u32,
    pub version: &'static str,
    pub channel: &'static str,
    pub checkpoint: &'static str,
    pub checkout: PathBuf,
    pub executable: PathBuf,
    pub state_root: PathBuf,
    pub host_os: &'static str,
    pub host_arch: &'static str,
    pub runtime_execution_supported: bool,
    pub runtime_lifecycle_qualified: bool,
}

impl Candidate {
    /// Construct a checkout-local identity without creating state or inspecting credentials.
    pub fn discover(checkout: &Path) -> Result<Self, CandidateError> {
        let checkout = canonical_directory(checkout)?;
        let state_root = checkout.join(".hack-local");
        reject_aliased_state(&state_root)?;
        Ok(Self {
            protocol_version: PROTOCOL_VERSION,
            version: CANDIDATE_VERSION,
            channel: "local-candidate",
            checkpoint: "WU05-source-sync-WU06-source-jobs-in-progress",
            checkout,
            executable: std::env::current_exe().map_err(|error| {
                CandidateError::new("executable_unavailable", error.to_string())
            })?,
            state_root,
            host_os: std::env::consts::OS,
            host_arch: std::env::consts::ARCH,
            runtime_execution_supported: cfg!(all(target_os = "macos", target_arch = "aarch64")),
            runtime_lifecycle_qualified: false,
        })
    }

    /// Discover an explicitly selected private installed home without creating it.
    /// `checkout` remains the durable root identifier for existing child/receipt contracts;
    /// it is independent of the executable's versioned installation directory.
    pub fn discover_installed(home: &Path) -> Result<Self, CandidateError> {
        use std::os::unix::fs::MetadataExt;
        if !home.is_absolute()
            || home
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err(CandidateError::new(
                "invalid_candidate_home",
                "Candidate home must be an absolute path without parent traversal.",
            ));
        }
        reject_aliased_state(home)?;
        let metadata = home.symlink_metadata().map_err(|_| {
            CandidateError::new(
                "invalid_candidate_home",
                "Candidate home must already exist.",
            )
        })?;
        validate_installed_home_metadata(
            metadata.is_dir(),
            metadata.uid(),
            metadata.mode(),
            unsafe { libc::geteuid() },
        )?;
        let mut candidate = Self::discover(home)?;
        candidate.channel = "installed-candidate";
        Ok(candidate)
    }

    /// Preview a workspace attachment; it neither reads project configuration nor registers it.
    pub fn plan(&self, project: &Path) -> Result<WorkspacePlan, CandidateError> {
        let project = canonical_directory(project)?;
        if project.starts_with(&self.state_root) || self.state_root.starts_with(&project) {
            return Err(CandidateError::new(
                "overlapping_workspace",
                "Use a separate project checkout: source must not contain candidate state or live inside it.",
            ));
        }
        let project_text = project.to_str().ok_or_else(|| {
            CandidateError::new("unsupported_path", "Project path must be valid UTF-8.")
        })?;
        let namespace = format!("{:x}", Sha256::digest(project_text.as_bytes()));
        let planned_paths = PlannedPaths {
            provider_home: self.state_root.join("run/provider"),
            docker_config: self.state_root.join("run/docker-config"),
            workspace_state: self.state_root.join("run/workspaces").join(&namespace),
            artifact_root: self.state_root.join("artifacts").join(&namespace),
        };
        // Check every existing component of each planned path. No symlinked state is adopted.
        for path in [
            &planned_paths.provider_home,
            &planned_paths.docker_config,
            &planned_paths.workspace_state,
            &planned_paths.artifact_root,
        ] {
            reject_aliased_state(path)?;
        }
        Ok(WorkspacePlan {
            protocol_version: PROTOCOL_VERSION,
            mode: "read-only-preview",
            candidate_version: CANDIDATE_VERSION,
            provider_intent: match (self.host_os, self.host_arch) {
                ("macos", "aarch64") => "smolvm-libkrun",
                ("linux", "aarch64" | "x86_64") => "native-linux-docker",
                _ => "unsupported-host",
            },
            runtime_execution_supported: false,
            source: project,
            namespace,
            planned_paths,
            source_policy: "single-writer-sync; immutable job inputs",
            project_configuration_loaded: false,
            effects: [],
            next_checkpoint: "WU03-project-plan; WU01 preview is not an enrollment plan",
        })
    }
}

#[derive(Debug, Serialize)]
pub struct PlannedPaths {
    pub provider_home: PathBuf,
    pub docker_config: PathBuf,
    pub workspace_state: PathBuf,
    pub artifact_root: PathBuf,
}

#[derive(Debug, Serialize)]
pub struct WorkspacePlan {
    pub protocol_version: u32,
    pub mode: &'static str,
    pub candidate_version: &'static str,
    pub provider_intent: &'static str,
    pub runtime_execution_supported: bool,
    pub source: PathBuf,
    pub namespace: String,
    pub planned_paths: PlannedPaths,
    pub source_policy: &'static str,
    pub project_configuration_loaded: bool,
    pub effects: [&'static str; 0],
    pub next_checkpoint: &'static str,
}

fn canonical_directory(path: &Path) -> Result<PathBuf, CandidateError> {
    let canonical = path
        .canonicalize()
        .map_err(|error| CandidateError::new("invalid_directory", error.to_string()))?;
    if !canonical.is_dir() {
        return Err(CandidateError::new(
            "invalid_directory",
            "Expected an existing directory.",
        ));
    }
    Ok(canonical)
}

fn reject_aliased_state(path: &Path) -> Result<(), CandidateError> {
    for component in path.ancestors() {
        match component.symlink_metadata() {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(CandidateError::new(
                    "aliased_state",
                    format!(
                        "Candidate state must not follow a symlink: {}",
                        component.display()
                    ),
                ));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(CandidateError::new(
                    "invalid_state",
                    format!(
                        "Candidate state component is not a directory: {}",
                        component.display()
                    ),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(CandidateError::new("state_unavailable", error.to_string()));
            }
        }
    }
    Ok(())
}

/// Keep ownership validation independently testable without privileged chown operations.
fn validate_installed_home_metadata(
    directory: bool,
    owner: u32,
    mode: u32,
    current_user: u32,
) -> Result<(), CandidateError> {
    if !directory || owner != current_user || mode & 0o777 != 0o700 {
        return Err(CandidateError::new(
            "unsafe_candidate_home",
            "Candidate home must be a current-user-owned directory with mode 0700.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod installed_home_tests {
    use super::*;

    #[test]
    fn refuses_foreign_public_or_non_directory_home() {
        assert!(validate_installed_home_metadata(true, 501, 0o40700, 501).is_ok());
        for (directory, owner, mode) in [
            (true, 502, 0o40700),
            (true, 501, 0o40755),
            (false, 501, 0o100700),
        ] {
            assert_eq!(
                validate_installed_home_metadata(directory, owner, mode, 501)
                    .unwrap_err()
                    .code,
                "unsafe_candidate_home"
            );
        }
    }
}
