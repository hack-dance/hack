//! Checkout-local v5 candidate contracts and experimental private runtime lifecycle.
//! Project planning remains read-only; provider commands are explicit and separately qualified.

pub mod canonical_digest;
pub mod node;
#[cfg(test)]
pub(crate) mod owned_tmp_root;
pub mod project;
pub mod provider;
pub mod service;
pub mod store;
#[cfg(test)]
mod test_root;
pub mod timings;
#[cfg(test)]
pub(crate) use test_root::{private_test_root, unique_test_root};

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const PROTOCOL_VERSION: u32 = 1;
pub const CANDIDATE_VERSION: &str = "5.0.0-dev.6";

mod error;
mod error_stop_diagnostics;
mod hex;
pub mod sha256_backend;
mod sha256_guard;
pub use error::{CandidateError, ErrorMessage, LogFailurePhase, ProbeFinding, ProbeReason};
pub use hex::Hex;
#[cfg(all(test, feature = "native-config-plan"))]
mod test_budget;
#[cfg(test)]
mod test_scratch;
#[cfg(all(test, feature = "native-config-plan"))]
pub(crate) use test_budget::TEST_RUN_BUDGET;
#[cfg(test)]
pub(crate) use test_scratch::next_test_scratch;

/// Raise this process's soft descriptor limit once before dispatch. Keep a higher
/// inherited limit and leave the hard limit alone.
pub fn raise_open_file_limit() {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: limit is writable storage for getrlimit and initialized for setrlimit.
    unsafe {
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) == 0 {
            let target = limit.rlim_max.min(10_240);
            if limit.rlim_cur < target {
                limit.rlim_cur = target;
                let _ = libc::setrlimit(libc::RLIMIT_NOFILE, &limit);
            }
        }
    }
}

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
        // Registered first, so a malformed root is still named in its own refusal.
        register_state_root(&state_root);
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
        self.plan_with_branch(project, None)
    }

    /// Select a branch-specific namespace without changing legacy unscoped identities.
    pub fn plan_with_branch(
        &self,
        project: &Path,
        branch: Option<&str>,
    ) -> Result<WorkspacePlan, CandidateError> {
        if let Some(branch) = branch {
            validate_branch(branch)?;
        }
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
        let namespace = if let Some(branch) = branch {
            let mut digest = Sha256::new();
            digest.update(b"hack-native-branch-namespace-v1\0");
            digest.update(project_text.as_bytes());
            digest.update(b"\0");
            digest.update(branch.as_bytes());
            format!("{:x}", crate::Hex(digest.finalize()))
        } else {
            format!("{:x}", crate::Hex(Sha256::digest(project_text.as_bytes())))
        };
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

/// Branch selectors are canonical DNS labels, not filesystem paths or display names.
pub fn validate_branch(branch: &str) -> Result<(), CandidateError> {
    let bytes = branch.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 63
        || !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit()
        || !bytes[bytes.len() - 1].is_ascii_lowercase() && !bytes[bytes.len() - 1].is_ascii_digit()
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
    {
        return Err(CandidateError::new(
            "invalid_branch",
            "Branch selector must be a canonical lowercase DNS label of at most 63 bytes.",
        ));
    }
    Ok(())
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

/// Canonical state roots of the candidates this process discovered. Only a path beneath
/// one of them is named in a diagnostic; project paths never lie inside a native home.
static STATE_ROOTS: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

fn register_state_root(state_root: &Path) {
    if let Ok(mut roots) = STATE_ROOTS.lock() {
        if !roots.iter().any(|root| root == state_root) {
            roots.push(state_root.to_path_buf());
        }
    }
}

/// A state path for diagnostics, relative to the candidate state root it lies beneath
/// (`.hack-local/...`). Anything else, a project path or a home directory included, gets
/// no label, so nothing a user named is ever carried.
fn state_component_label(component: &Path) -> Option<String> {
    let roots = STATE_ROOTS.lock().ok()?;
    let root = roots.iter().find(|root| component.starts_with(root))?;
    let relative = component.strip_prefix(root).ok()?.to_str()?;
    Some(if relative.is_empty() {
        ".hack-local".to_owned()
    } else {
        format!(".hack-local/{relative}")
    })
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
                )
                .with_state_component(&state_component_label(component).unwrap_or_default()));
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

#[cfg(test)]
mod state_component_tests {
    use super::*;

    #[test]
    fn a_non_directory_state_component_carries_its_path_relative_to_the_state_root() {
        let root = private_test_root(
            &std::env::temp_dir().canonicalize().unwrap(),
            "hack-state-component",
        );
        let state = root.join(".hack-local");
        std::fs::create_dir_all(state.join("run")).unwrap();
        register_state_root(&state);
        std::fs::write(state.join("run/graphs"), b"not a directory").unwrap();
        // The checked path itself is a file: the shape behind `invalid_state`.
        let error = reject_aliased_state(&state.join("run/graphs")).unwrap_err();
        assert_eq!(error.code, "invalid_state");
        let wire = serde_json::to_value(&error).unwrap();
        assert_eq!(
            wire["state_component"],
            serde_json::json!({"version": 1, "path": ".hack-local/run/graphs"})
        );
        // A project file, a file directly in the state root, or a project directory that
        // happens to be named .hack-local, carries no label.
        let project = root.join("project");
        std::fs::create_dir_all(project.join(".hack-local")).unwrap();
        std::fs::create_dir_all(project.join(".hack-local/run")).unwrap();
        for path in [
            root.join("confidential-plan.txt"),
            project.join(".hack-local/notes"),
            // The allowed state prefix inside a project is still project data.
            project.join(".hack-local/run/confidential-acquisition.txt"),
        ] {
            std::fs::write(&path, b"x").unwrap();
            let refused = reject_aliased_state(&path).unwrap_err();
            assert_eq!(refused.code, "invalid_state");
            let wire = serde_json::to_value(&refused).unwrap();
            assert!(wire.get("state_component").is_none(), "{wire}");
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn discovery_names_a_state_root_that_is_a_file() {
        let home = private_test_root(
            &std::env::temp_dir().canonicalize().unwrap(),
            "hack-state-root-file",
        );
        std::fs::write(home.join(".hack-local"), b"not a directory").unwrap();
        let error = Candidate::discover(&home).unwrap_err();
        assert_eq!(error.code, "invalid_state");
        let wire = serde_json::to_value(&error).unwrap();
        assert_eq!(wire["state_component"]["path"], ".hack-local");
        std::fs::remove_dir_all(&home).unwrap();
    }
}

/// Experimental guest transport. Lifecycle callers still use the provider.
#[cfg(all(unix, feature = "guest-agent-client"))]
pub use hack_vm_protocol as guest_agent;
