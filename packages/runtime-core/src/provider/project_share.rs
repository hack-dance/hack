//! Explicit unfiltered writable development tree. Snapshot exclusions do not apply.
use crate::{CandidateError, reject_aliased_state};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectShareIntent {
    pub project: PathBuf,
    pub guest_path: String,
    pub device: u64,
    pub inode: u64,
    pub unfiltered_source: bool,
}
fn refused() -> CandidateError {
    CandidateError::new(
        "project_share",
        "An explicit unfiltered project share requires the exact canonical owned project directory; pool mount changes are refused.",
    )
}
impl ProjectShareIntent {
    /// Approves the whole project tree, including local configuration files, for
    /// guest reads and writes. Never called implicitly by filtered source capture.
    pub fn approve(project: &Path, unfiltered_source: bool) -> Result<Self, CandidateError> {
        reject_aliased_state(project)?;
        let canonical = fs::canonicalize(project).map_err(|_| refused())?;
        let text = project.to_str().ok_or_else(refused)?;
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(refused)?;
        if !unfiltered_source || canonical != project || !project.is_absolute()
            || text.contains(':') || text.chars().any(char::is_control)
            || home.starts_with(project)
            || project.components().any(|c| matches!(c, Component::Normal(n) if [".aws", ".ssh", ".gnupg", ".codex", ".config"].iter().any(|v| n == *v)))
            || project.file_name().is_none_or(|n| ["dev","projects","workspaces","src"].iter().any(|v| n == *v))
            || !["package.json","Cargo.toml","pyproject.toml","go.mod",".hack/docker-compose.yml","compose.yaml","docker-compose.yml"].iter().any(|name| project.join(name).is_file())
        { return Err(refused()); }
        let meta = fs::symlink_metadata(project).map_err(|_| refused())?;
        if !meta.is_dir() || meta.uid() != current_uid() || meta.mode() & 0o022 != 0 {
            return Err(refused());
        }
        let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
        Ok(Self {
            project: project.into(),
            guest_path: format!("/mnt/hack-projects/{digest}"),
            device: meta.dev(),
            inode: meta.ino(),
            unfiltered_source,
        })
    }
    /// Checks the stored mount identity without consulting a mutable host tree.
    /// Stop and cleanup must remain possible after a project is moved or deleted.
    pub(super) fn validate_receipt(&self) -> Result<(), CandidateError> {
        let text = self.project.to_str().ok_or_else(refused)?;
        let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
        if !self.unfiltered_source
            || !self.project.is_absolute()
            || self
                .project
                .components()
                .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
            || text.contains(':')
            || text.chars().any(char::is_control)
            || self.guest_path != format!("/mnt/hack-projects/{digest}")
        {
            return Err(refused());
        }
        Ok(())
    }
    /// Bind only ordinary descendants of the approved directory. Reject aliases
    /// at every existing path component before passing the path to the guest.
    pub(super) fn bind_path(&self, source: &str) -> Result<String, CandidateError> {
        self.validate()?;
        if source == "." {
            return Ok(self.guest_path.clone());
        }
        let relative = Path::new(source);
        if source.is_empty()
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(refused());
        }
        let path = self.project.join(relative);
        reject_aliased_state(&path)?;
        let metadata = fs::symlink_metadata(&path).map_err(|_| refused())?;
        if !(metadata.is_file() || metadata.is_dir())
            || fs::canonicalize(&path).map_err(|_| refused())? != path
        {
            return Err(refused());
        }
        Ok(format!("{}/{}", self.guest_path, source))
    }
    pub(super) fn validate(&self) -> Result<(), CandidateError> {
        if Self::approve(&self.project, self.unfiltered_source)? != *self {
            return Err(refused());
        }
        Ok(())
    }
    pub(super) fn argument(&self) -> String {
        format!("{}:{}:rw", self.project.display(), self.guest_path)
    }
    pub(super) fn running_mount(&self) -> Value {
        json!({"source":self.project,"target":self.guest_path,"read_only":false,"staged":false})
    }
    pub(super) fn database_mount(&self) -> Value {
        json!([self.project, self.guest_path, false])
    }
}
pub(super) fn check_request(
    existing: Option<&ProjectShareIntent>,
    requested: Option<&ProjectShareIntent>,
) -> Result<(), CandidateError> {
    if let Some(requested) = requested {
        requested.validate()?;
        if existing != Some(requested) {
            return Err(refused());
        }
    }
    if let Some(existing) = existing {
        existing.validate()?;
    }
    Ok(())
}

fn current_uid() -> u32 {
    // SAFETY: geteuid takes no pointers and has no caller preconditions.
    unsafe { libc::geteuid() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "hack-share-{}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
            fs::write(root.join("package.json"), "{}").unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn project_share_receipt_survives_removed_source_but_activation_refuses() {
        let fixture = Fixture::new();
        let intent = ProjectShareIntent::approve(&fixture.0, true).unwrap();
        let moved = Fixture::new();
        fs::rename(&fixture.0, moved.0.join("old-project")).unwrap();
        assert!(intent.validate_receipt().is_ok());
        assert!(intent.validate().is_err());
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&fixture.0)
            .unwrap();
        fs::write(fixture.0.join("package.json"), "{}").unwrap();
        assert!(intent.validate().is_err());
        let mut forged = intent.clone();
        forged.guest_path.push_str("/other");
        assert!(forged.validate_receipt().is_err());
    }
    #[test]
    fn project_share_requires_acknowledgement_and_rejects_aliases_and_escape() {
        let fixture = Fixture::new();
        assert!(ProjectShareIntent::approve(&fixture.0, false).is_err());
        let intent = ProjectShareIntent::approve(&fixture.0, true).unwrap();
        fs::create_dir(fixture.0.join("app")).unwrap();
        assert_eq!(
            intent.bind_path("app").unwrap(),
            format!("{}/app", intent.guest_path)
        );
        assert_eq!(intent.bind_path(".").unwrap(), intent.guest_path);
        for path in [
            "",
            "..",
            "../elsewhere",
            "/tmp",
            "app/../package.json",
            "missing",
        ] {
            assert!(intent.bind_path(path).is_err(), "accepted {path}");
        }
        symlink("app", fixture.0.join("alias")).unwrap();
        assert!(intent.bind_path("alias").is_err());
        assert!(ProjectShareIntent::approve(&fixture.0.join("alias"), true).is_err());
        fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(intent.validate().is_err());
    }
    #[test]
    fn project_share_pool_intent_cannot_change_implicitly() {
        let first = Fixture::new();
        let second = Fixture::new();
        let a = ProjectShareIntent::approve(&first.0, true).unwrap();
        let b = ProjectShareIntent::approve(&second.0, true).unwrap();
        assert!(check_request(Some(&a), Some(&a)).is_ok());
        assert!(check_request(Some(&a), None).is_ok());
        assert!(check_request(Some(&a), Some(&b)).is_err());
        assert!(check_request(None, Some(&a)).is_err());
    }
}
