//! Explicit unfiltered writable development tree. Snapshot exclusions do not apply.
mod worktree;

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
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(refused)?;
        Self::approve_with_home(project, unfiltered_source, &home)
    }
    fn approve_with_home(
        project: &Path,
        unfiltered_source: bool,
        home: &Path,
    ) -> Result<Self, CandidateError> {
        reject_aliased_state(project)?;
        let canonical = fs::canonicalize(project).map_err(|_| refused())?;
        let text = project.to_str().ok_or_else(refused)?;
        if !unfiltered_source || canonical != project || !project.is_absolute()
            || text.contains(':') || text.chars().any(char::is_control)
            || home.starts_with(project)
            || project.components().any(|c| matches!(c, Component::Normal(n) if [".aws", ".ssh", ".gnupg", ".config"].iter().any(|v| n == *v)))
            || project.file_name().is_none_or(|n| ["dev","projects","workspaces","src"].iter().any(|v| n == *v))
            || !["package.json","Cargo.toml","pyproject.toml","go.mod",".hack/docker-compose.yml","compose.yaml","docker-compose.yml"].iter().any(|name| project.join(name).is_file())
        { return Err(refused()); }
        let codex_components = project
            .components()
            .filter(|c| matches!(c, Component::Normal(n) if *n == ".codex"))
            .count();
        if codex_components > 0 {
            if codex_components != 1 {
                return Err(refused());
            }
            worktree::verify(project, home)?;
        }
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
/// Upper bound for one pool's share set: the primary share plus additional roots.
/// Each share is one provider filesystem device for the life of the machine.
pub const MAX_PROJECT_SHARES: usize = 8;

fn extension_required() -> CandidateError {
    CandidateError::new(
        "project_share_extension_required",
        "This pool does not share this project root. Add it to the stopped pool with `runtime project-share add`; a running pool's mounts are never changed.",
    )
}

/// Offline shape of a pool share set. Every share keeps its own exact receipt and
/// guest path; no two shares name the same root or guest mount point. Additional
/// shares exist only beside a primary share, which defines the pool as a
/// development source pool.
pub(super) fn validate_set(
    primary: Option<&ProjectShareIntent>,
    additional: &[ProjectShareIntent],
) -> Result<(), CandidateError> {
    if primary.is_none() && !additional.is_empty() {
        return Err(refused());
    }
    let shares: Vec<_> = primary.into_iter().chain(additional).collect();
    if shares.len() > MAX_PROJECT_SHARES {
        return Err(refused());
    }
    for (index, share) in shares.iter().enumerate() {
        share.validate_receipt()?;
        if shares[..index]
            .iter()
            .any(|other| other.project == share.project || other.guest_path == share.guest_path)
        {
            return Err(refused());
        }
    }
    Ok(())
}

/// Admit a requested share only when it is already an exact member of the pool's
/// share set. A root outside the set is refused with a distinct code: the set changes
/// only through the explicit stopped-pool extension, never as a side effect of `up`.
/// Without a request every share is checked live, as before; with a request, the
/// requested share is checked live and the others offline, so a moved or deleted
/// neighbor root cannot block an unrelated project on a running pool. Boot checks
/// every share live before the provider starts.
pub(super) fn check_request(
    existing: &[&ProjectShareIntent],
    requested: Option<&ProjectShareIntent>,
) -> Result<(), CandidateError> {
    for share in existing {
        share.validate_receipt()?;
    }
    if let Some(requested) = requested {
        requested.validate()?;
        if !existing.contains(&requested) {
            return Err(if existing.is_empty() {
                refused()
            } else {
                extension_required()
            });
        }
    } else {
        for share in existing {
            share.validate()?;
        }
    }
    Ok(())
}

/// Every share must still name its exact approved directory before the provider boots
/// with it; a stale additional share is removed explicitly, never skipped.
pub(super) fn check_boot(existing: &[&ProjectShareIntent]) -> Result<(), CandidateError> {
    for share in existing {
        share.validate().map_err(|_| {
            CandidateError::new(
                "project_share_stale",
                "A shared project root moved, changed or was removed. Remove that additional share from the stopped pool with `runtime project-share remove` before booting.",
            )
        })?;
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

    struct RegisteredWorktree {
        _fixture: Fixture,
        home: PathBuf,
        project: PathBuf,
        common: PathBuf,
        gitdir: PathBuf,
    }
    impl RegisteredWorktree {
        fn new() -> Self {
            Self::at(".codex/worktrees/example/app")
        }
        fn at(relative: &str) -> Self {
            let fixture = Fixture::new();
            let home = fixture.0.join("home");
            let main = fixture.0.join("main");
            let project = home.join(relative);
            fs::DirBuilder::new()
                .mode(0o700)
                .recursive(true)
                .create(project.parent().unwrap())
                .unwrap();
            let git = |args: &[&std::ffi::OsStr]| {
                let output = std::process::Command::new("git")
                    .env_clear()
                    .env("PATH", std::env::var_os("PATH").unwrap())
                    .env("HOME", &home)
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .env("GIT_CONFIG_GLOBAL", "/dev/null")
                    .args(args)
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "fixture git failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            };
            git(&[
                "-c".as_ref(),
                "init.templateDir=".as_ref(),
                "init".as_ref(),
                "--quiet".as_ref(),
                main.as_os_str(),
            ]);
            git(&[
                "-C".as_ref(),
                main.as_os_str(),
                "-c".as_ref(),
                "user.name=Fixture".as_ref(),
                "-c".as_ref(),
                "user.email=fixture@example.invalid".as_ref(),
                "-c".as_ref(),
                "commit.gpgsign=false".as_ref(),
                "commit".as_ref(),
                "--quiet".as_ref(),
                "--allow-empty".as_ref(),
                "-m".as_ref(),
                "fixture".as_ref(),
            ]);
            git(&[
                "-C".as_ref(),
                main.as_os_str(),
                "worktree".as_ref(),
                "add".as_ref(),
                "--quiet".as_ref(),
                "--detach".as_ref(),
                project.as_os_str(),
                "HEAD".as_ref(),
            ]);
            fs::write(project.join("package.json"), "{}").unwrap();
            let pointer = fs::read_to_string(project.join(".git")).unwrap();
            let gitdir = PathBuf::from(pointer.trim().strip_prefix("gitdir: ").unwrap());
            Self {
                _fixture: fixture,
                home,
                project,
                common: main.join(".git"),
                gitdir,
            }
        }
        fn approve(&self) -> Result<ProjectShareIntent, CandidateError> {
            ProjectShareIntent::approve_with_home(&self.project, true, &self.home)
        }
    }

    #[test]
    fn project_share_codex_exception_does_not_admit_sensitive_or_neighbor_layouts() {
        for relative in [
            ".codex/worktrees/.aws/app",
            ".codex/worktrees/.ssh/app",
            ".codex/worktrees/.gnupg/app",
            ".codex/worktrees/example/.config",
            ".codex/worktrees/.codex/app",
            ".codex/neighbor/example/app",
            "other/.codex/worktrees/example/app",
            ".codex/worktrees/outer/example/app",
            ".codex/worktrees/app",
        ] {
            let fixture = RegisteredWorktree::at(relative);
            assert!(fixture.approve().is_err(), "accepted {relative}");
        }
    }

    #[test]
    fn project_share_allows_only_exact_registered_codex_worktree_with_consent() {
        let fixture = RegisteredWorktree::new();
        let intent = fixture.approve().unwrap();
        assert_eq!(intent.project, fixture.project);
        assert_eq!(
            intent.argument(),
            format!("{}:{}:rw", fixture.project.display(), intent.guest_path)
        );
        assert!(!intent.argument().contains(fixture.common.to_str().unwrap()));
        assert!(
            ProjectShareIntent::approve_with_home(&fixture.project, false, &fixture.home).is_err()
        );
        for path in [
            fixture.home.clone(),
            fixture.home.join(".codex"),
            fixture.home.join(".codex/worktrees"),
            fixture.project.parent().unwrap().to_path_buf(),
            fixture.home.join(".codex/worktrees/example/neighbor"),
            fixture.project.join("nested"),
        ] {
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("package.json"), "{}").unwrap();
            assert!(
                ProjectShareIntent::approve_with_home(&path, true, &fixture.home).is_err(),
                "accepted {}",
                path.display()
            );
        }
        assert!(fixture.approve().is_ok());
    }

    #[test]
    fn project_share_codex_worktree_requires_exact_backlink_and_common_registration() {
        let fixture = RegisteredWorktree::new();
        let backlink = fixture.gitdir.join("gitdir");
        let original = fs::read(&backlink).unwrap();
        fs::write(
            &backlink,
            format!(
                "{}\n",
                fixture
                    .project
                    .with_file_name("neighbor")
                    .join(".git")
                    .display()
            ),
        )
        .unwrap();
        assert!(fixture.approve().is_err());
        fs::write(&backlink, &original).unwrap();
        assert!(fixture.approve().is_ok());

        let commondir = fixture.gitdir.join("commondir");
        let original = fs::read(&commondir).unwrap();
        fs::write(&commondir, "../../../\n").unwrap();
        assert!(fixture.approve().is_err());
        fs::write(&commondir, &original).unwrap();
        assert!(fixture.approve().is_ok());

        // Even internally consistent pointers must be one immediate registration.
        let nested = fixture.gitdir.join("nested");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("commondir"), "../../..\n").unwrap();
        fs::write(nested.join("gitdir"), fs::read(&backlink).unwrap()).unwrap();
        fs::write(
            fixture.project.join(".git"),
            format!("gitdir: {}\n", nested.display()),
        )
        .unwrap();
        assert!(fixture.approve().is_err());
    }

    #[test]
    fn project_share_codex_worktree_refuses_pointer_aliases_and_unbounded_metadata() {
        let fixture = RegisteredWorktree::new();
        for path in [
            fixture.project.join(".git"),
            fixture.gitdir.join("commondir"),
            fixture.gitdir.join("gitdir"),
        ] {
            let saved = path.with_extension("saved");
            fs::rename(&path, &saved).unwrap();
            symlink(&saved, &path).unwrap();
            assert!(fixture.approve().is_err());
            fs::remove_file(&path).unwrap();
            fs::hard_link(&saved, &path).unwrap();
            assert!(fixture.approve().is_err());
            fs::remove_file(&path).unwrap();
            fs::write(&path, "x".repeat(4097)).unwrap();
            assert!(fixture.approve().is_err());
            fs::remove_file(&path).unwrap();
            fs::create_dir(&path).unwrap();
            assert!(fixture.approve().is_err());
            fs::remove_dir(&path).unwrap();
            fs::rename(&saved, &path).unwrap();
            assert!(fixture.approve().is_ok());
        }
        let alias = fixture.home.join("git-alias");
        symlink(&fixture.common, &alias).unwrap();
        fs::write(
            fixture.project.join(".git"),
            format!(
                "gitdir: {}/worktrees/{}\n",
                alias.display(),
                fixture.gitdir.file_name().unwrap().to_str().unwrap()
            ),
        )
        .unwrap();
        assert!(fixture.approve().is_err());
    }

    #[test]
    fn project_share_codex_worktree_refuses_unsafe_directories_and_metadata() {
        let fixture = RegisteredWorktree::new();
        for path in [
            fixture.home.clone(),
            fixture.home.join(".codex"),
            fixture.home.join(".codex/worktrees"),
            fixture.project.parent().unwrap().to_path_buf(),
            fixture.project.clone(),
            fixture.common.parent().unwrap().to_path_buf(),
            fixture.common.clone(),
            fixture.common.join("worktrees"),
            fixture.gitdir.clone(),
            fixture.project.join(".git"),
            fixture.gitdir.join("commondir"),
            fixture.gitdir.join("gitdir"),
        ] {
            let permissions = fs::metadata(&path).unwrap().permissions();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o777)).unwrap();
            assert!(fixture.approve().is_err(), "accepted {}", path.display());
            fs::set_permissions(&path, permissions).unwrap();
            assert!(fixture.approve().is_ok());
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
        assert!(check_request(&[&a], Some(&a)).is_ok());
        assert!(check_request(&[&a], None).is_ok());
        assert_eq!(
            check_request(&[&a], Some(&b)).unwrap_err().code,
            "project_share_extension_required"
        );
        assert_eq!(
            check_request(&[], Some(&a)).unwrap_err().code,
            "project_share"
        );
        // Membership is exact: a forged receipt for the same root is not a member.
        let mut forged = b.clone();
        forged.inode += 1;
        assert!(check_request(&[&a, &b], Some(&forged)).is_err());
        assert!(check_request(&[&a, &b], Some(&b)).is_ok());
    }

    #[test]
    fn project_share_set_is_bounded_unique_and_requires_a_primary() {
        let fixtures: Vec<_> = (0..MAX_PROJECT_SHARES + 1)
            .map(|_| Fixture::new())
            .collect();
        let shares: Vec<_> = fixtures
            .iter()
            .map(|f| ProjectShareIntent::approve(&f.0, true).unwrap())
            .collect();
        assert!(validate_set(None, &[]).is_ok());
        assert!(validate_set(Some(&shares[0]), &[]).is_ok());
        assert!(validate_set(Some(&shares[0]), &shares[1..MAX_PROJECT_SHARES]).is_ok());
        assert!(validate_set(Some(&shares[0]), &shares[1..]).is_err());
        assert!(validate_set(None, &shares[1..2]).is_err());
        assert!(validate_set(Some(&shares[0]), &[shares[0].clone()]).is_err());
        let mut same_guest = shares[1].clone();
        same_guest.guest_path = shares[0].guest_path.clone();
        assert!(validate_set(Some(&shares[0]), &[same_guest]).is_err());
    }

    #[test]
    fn project_share_running_neighbor_removal_does_not_block_other_roots_but_blocks_boot() {
        let first = Fixture::new();
        let second = Fixture::new();
        let a = ProjectShareIntent::approve(&first.0, true).unwrap();
        let b = ProjectShareIntent::approve(&second.0, true).unwrap();
        let moved = Fixture::new();
        fs::rename(&second.0, moved.0.join("gone")).unwrap();
        assert!(check_request(&[&a, &b], Some(&a)).is_ok());
        assert!(check_request(&[&a, &b], Some(&b)).is_err());
        assert!(check_request(&[&a, &b], None).is_err());
        assert_eq!(
            check_boot(&[&a, &b]).unwrap_err().code,
            "project_share_stale"
        );
        assert!(check_boot(&[&a]).is_ok());
    }

    #[test]
    fn project_share_bind_paths_never_cross_into_a_neighbor_share() {
        let first = Fixture::new();
        let second = Fixture::new();
        let a = ProjectShareIntent::approve(&first.0, true).unwrap();
        let b = ProjectShareIntent::approve(&second.0, true).unwrap();
        assert_ne!(a.guest_path, b.guest_path);
        for source in [
            b.guest_path.as_str(),
            second.0.to_str().unwrap(),
            "../",
            "/mnt/hack-projects",
        ] {
            assert!(a.bind_path(source).is_err(), "accepted {source}");
        }
        assert!(a.bind_path(".").unwrap().starts_with(&a.guest_path));
    }
}
