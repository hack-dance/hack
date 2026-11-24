//! Git status for Hack's files in the selected checkout.

use std::{collections::BTreeSet, path::Path, time::Duration};

use crate::{
    runner::{CliRunner, resolve_on_path},
    source::trusted_root,
};

pub const REFUSED: &str =
    "Can’t check changes here. Verify checkout ownership and write permissions.";

#[derive(Debug, PartialEq, Eq)]
pub struct Changes {
    pub branch: String,
    pub checkout: String,
    pub files: Vec<ChangedFile>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ChangedFile {
    pub path: String,
    pub state: String,
}

fn git_runner(root: &Path) -> Result<CliRunner, &'static str> {
    let path_git = resolve_on_path("git", std::env::var_os("PATH").as_deref());
    path_git
        .into_iter()
        .chain([std::path::PathBuf::from("/usr/bin/git")])
        .map(|git| CliRunner::verified(git).with_clean_env().with_cwd(root))
        .find(|runner| runner.resolve_program().is_ok())
        .ok_or("Verified Git is unavailable")
}

fn trusted_config_file(path: &Path, uid: u32) -> bool {
    crate::doctor_plugins::guarded_names(path, uid, &mut 64, false) && path.is_file()
}

impl Changes {
    /// A path-limited status read with no optional index update.
    pub fn read(root: &Path) -> Result<Self, &'static str> {
        let root = trusted_root(root).map_err(|_| REFUSED)?;
        let mut runner = git_runner(&root)?;
        for key in ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"] {
            if let Ok(value) = std::env::var(key) {
                runner = runner.with_env(key, &value);
            }
        }
        Self::read_status(&root, &runner)
    }

    fn read_status(root: &Path, runner: &CliRunner) -> Result<Self, &'static str> {
        let checkout = root
            .file_name()
            .ok_or("Checkout name unavailable")?
            .to_string_lossy()
            .into_owned();
        let runner = runner
            .clone()
            .with_env("GIT_OPTIONAL_LOCKS", "0")
            .with_env("LC_ALL", "C");
        let (entries, _, code) = runner
            .run_raw(
                &["config", "--null", "--show-origin", "--name-only", "--list"],
                None,
                Duration::from_secs(5),
            )
            .map_err(|_| "Git configuration could not be read")?;
        if code != Some(0) || (!entries.is_empty() && !entries.ends_with('\0')) {
            return Err("Git configuration could not be read");
        }
        // SAFETY: getuid has no preconditions.
        let uid = unsafe { libc::getuid() };
        let mut trusted = BTreeSet::new();
        let mut overrides = BTreeSet::new();
        let mut fields = entries.split_terminator('\0');
        while let Some(origin) = fields.next() {
            let key = fields.next().ok_or("Git configuration could not be read")?;
            let file = origin.strip_prefix("file:").ok_or(REFUSED)?;
            if trusted.insert(file) && !trusted_config_file(&root.join(file), uid) {
                return Err(REFUSED);
            }
            // Porcelain status can hash racily clean files through the
            // worktree-to-index conversion, even with optional locks off.
            if key.starts_with("filter.")
                && let Some((_, option)) = key.rsplit_once('.')
            {
                match option {
                    "clean" | "process" => {
                        overrides.insert(format!("{key}="));
                    }
                    "required" => {
                        overrides.insert(format!("{key}=false"));
                    }
                    _ => {}
                }
            }
        }
        let mut args = vec!["-c", "core.fsmonitor=false"];
        for setting in &overrides {
            args.extend(["-c", setting.as_str()]);
        }
        // Porcelain status doesn't emit patches or run textconv. Ignore
        // submodule worktree dirtiness to avoid a recursive status read.
        args.extend([
            "status",
            "--porcelain=v1",
            "-z",
            "--branch",
            "--no-renames",
            "--untracked-files=all",
            "--ignore-submodules=dirty",
            "--",
            ".hack/",
        ]);
        let (out, _, code) = runner
            .run_raw(&args, None, Duration::from_secs(5))
            .map_err(|_| "Git status could not be read")?;
        if code != Some(0) {
            return Err("Git status could not be read");
        }
        Self::parse(checkout, &out).ok_or("Git returned an incomplete status report")
    }

    fn parse(checkout: String, status: &str) -> Option<Self> {
        let mut records = status.strip_suffix('\0')?.split('\0');
        let head = records.next()?.strip_prefix("## ")?;
        let branch = if head == "HEAD (no branch)" {
            "Detached HEAD"
        } else {
            head.strip_prefix("No commits yet on ")
                .or_else(|| head.strip_prefix("Initial commit on "))
                .unwrap_or(head)
                .split("...")
                .next()?
        };
        let files = records
            .map(|record| {
                let (xy, path) = record.split_at_checked(3)?;
                let xy = xy.strip_suffix(' ')?;
                let state = match xy {
                    "??" => "Untracked",
                    "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU" => "Conflict",
                    _ if xy.contains('D') => "Deleted",
                    _ if xy.contains('A') => "Added",
                    _ if xy.contains('M') || xy.contains('T') => "Modified",
                    _ => return None,
                };
                Some(ChangedFile {
                    path: path.to_owned(),
                    state: state.into(),
                })
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            branch: branch.into(),
            checkout,
            files,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_retains_staging_only_changes_and_untracked_paths() {
        let status = "## develop...origin/develop [ahead 1]\0M  .hack/hack.config.json\0 M .hack/docker-compose.yml\0?? .hack/local notes.md\0";
        let changes = Changes::parse("storefront-dev".into(), status).unwrap();
        assert_eq!(changes.branch, "develop");
        assert_eq!(changes.checkout, "storefront-dev");
        assert_eq!(changes.files[0].state, "Modified");
        assert_eq!(changes.files[1].state, "Modified");
        assert_eq!(changes.files[2].state, "Untracked");
        assert_eq!(changes.files[2].path, ".hack/local notes.md");
        assert!(Changes::parse("storefront-dev".into(), status.trim_end_matches('\0')).is_none());
    }

    #[test]
    fn real_git_status_only_lists_hack_paths_and_preserves_the_index() {
        let (root, runner) = fixture("status");
        std::fs::write(root.join(".hack/hack.config.json"), "{}").unwrap();
        std::fs::write(root.join(".hack/notes.txt"), "fixture").unwrap();
        std::fs::write(root.join("unrelated.txt"), "fixture").unwrap();
        git(&runner, &["add", "--", ".hack/hack.config.json"]);
        let index_before = std::fs::read(root.join(".git/index")).unwrap();
        let status = Changes::read(&root);
        let index_after = std::fs::read(root.join(".git/index")).unwrap();
        std::fs::remove_dir_all(&root).unwrap();

        assert_eq!(index_before, index_after);
        let status = status.unwrap();
        assert_eq!(status.branch, "review");
        assert_eq!(
            status
                .files
                .iter()
                .map(|f| (f.path.as_str(), f.state.as_str()))
                .collect::<Vec<_>>(),
            [
                (".hack/hack.config.json", "Added"),
                (".hack/notes.txt", "Untracked")
            ]
        );
    }

    fn fixture(tag: &str) -> (std::path::PathBuf, CliRunner) {
        let root = std::env::temp_dir().join(format!("desktop-git-{tag}-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let runner = git_runner(&root).unwrap();
        git(&runner, &["init", "--initial-branch=review"]);
        std::fs::create_dir(root.join(".hack")).unwrap();
        std::fs::write(root.join(".hack/docker-compose.yml"), "services: {}").unwrap();
        git(&runner, &["add", ".hack/docker-compose.yml"]);
        git(
            &runner,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-m",
                "initial",
            ],
        );
        (root, runner)
    }

    fn git(runner: &CliRunner, args: &[&str]) {
        let (_, err, code) = runner.run_raw(args, None, Duration::from_secs(5)).unwrap();
        assert_eq!(code, Some(0), "{err}");
    }

    #[test]
    fn user_global_excludes_hide_ignored_hack_files() {
        let (root, runner) = fixture("ignores");
        std::fs::write(root.join(".hack/ignored.txt"), "fake").unwrap();
        std::fs::write(root.join("ignore"), ".hack/ignored.txt\n").unwrap();
        std::fs::write(root.join("global"), "[core]\nexcludesFile = ~/ignore\n").unwrap();
        let runner = runner
            .with_env("HOME", root.to_str().unwrap())
            .with_env("GIT_CONFIG_GLOBAL", root.join("global").to_str().unwrap());
        let report = Changes::read_status(&root, &runner).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        assert!(report.files.is_empty());
    }

    #[test]
    fn status_does_not_launch_clean_or_process_filters() {
        let (root, runner) = fixture("filters");
        std::fs::write(
            root.join(".gitattributes"),
            ".hack/docker-compose.yml filter=fixture\n",
        )
        .unwrap();
        let tracked = root.join(".hack/docker-compose.yml");
        let original_mtime = tracked.metadata().unwrap().modified().unwrap();
        std::fs::write(&tracked, "services: []").unwrap();
        let same_mtime = std::fs::FileTimes::new().set_modified(original_mtime);
        std::fs::File::open(tracked)
            .unwrap()
            .set_times(same_mtime)
            .unwrap();
        std::fs::File::open(root.join(".git/index"))
            .unwrap()
            .set_times(same_mtime)
            .unwrap();
        git(&runner, &["config", "core.trustctime", "false"]);
        git(
            &runner,
            &["config", "filter.fixture.clean", "touch marker; cat"],
        );
        git(
            &runner.clone().with_env("GIT_OPTIONAL_LOCKS", "0"),
            &["status", "--porcelain", "--", ".hack/"],
        );
        assert!(
            root.join("marker").is_file(),
            "ordinary status exercises the clean filter"
        );
        std::fs::remove_file(root.join("marker")).unwrap();
        let clean = Changes::read(&root).unwrap();
        assert!(!root.join("marker").exists());
        assert_eq!(clean.files[0].state, "Modified");
        git(
            &runner,
            &["config", "filter.fixture.process", "touch marker; exit 1"],
        );
        git(&runner, &["config", "filter.fixture.required", "true"]);
        let process = Changes::read(&root).unwrap();
        assert!(!root.join("marker").exists());
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(process, clean);
    }

    #[test]
    fn changes_refuse_a_writable_checkout() {
        use std::os::unix::fs::PermissionsExt;
        let (root, _) = fixture("untrusted");
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o775)).unwrap();
        let result = Changes::read(&root);
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(result, Err(REFUSED));
    }

    #[test]
    fn changes_refuse_a_writable_git_config() {
        use std::os::unix::fs::PermissionsExt;
        let (root, runner) = fixture("untrusted-config");
        git(
            &runner,
            &["config", "filter.fixture.clean", "touch marker; cat"],
        );
        std::fs::set_permissions(
            root.join(".git/config"),
            std::fs::Permissions::from_mode(0o664),
        )
        .unwrap();
        let result = Changes::read(&root);
        assert!(!root.join("marker").exists());
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(result, Err(REFUSED));
    }

    #[test]
    fn branch_headers_cover_unborn_and_detached_checkouts() {
        for (input, expected) in [
            ("## No commits yet on topic\0", "topic"),
            ("## HEAD (no branch)\0", "Detached HEAD"),
        ] {
            let changes = Changes::parse("worktree".into(), input).unwrap();
            assert_eq!(changes.branch, expected);
            assert!(changes.files.is_empty());
        }
    }
}
