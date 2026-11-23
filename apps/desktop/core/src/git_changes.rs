//! Git status for Hack's files in the selected checkout.

use std::{path::Path, time::Duration};

use crate::runner::{CliRunner, resolve_on_path};

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

impl Changes {
    /// A path-limited status read with no optional index update.
    pub fn read(root: &Path) -> Result<Self, &'static str> {
        if !root.is_absolute() {
            return Err("Checkout path unavailable");
        }
        let git = resolve_on_path("git", std::env::var_os("PATH").as_deref())
            .ok_or("Git is unavailable")?;
        let checkout = root
            .file_name()
            .ok_or("Checkout name unavailable")?
            .to_string_lossy()
            .into_owned();
        let (out, _, code) = CliRunner::verified(git)
            .with_clean_env()
            .with_env("GIT_OPTIONAL_LOCKS", "0")
            .with_env("LC_ALL", "C")
            .with_cwd(root)
            .run_raw(
                &[
                    "-c",
                    "core.fsmonitor=false",
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "--branch",
                    "--no-renames",
                    "--untracked-files=all",
                    "--ignore-submodules=dirty",
                    "--",
                    ".hack/",
                ],
                None,
                Duration::from_secs(5),
            )
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
        let root = std::env::temp_dir().join(format!("desktop-git-status-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let git = resolve_on_path("git", std::env::var_os("PATH").as_deref()).unwrap();
        let runner = CliRunner::verified(git).with_clean_env().with_cwd(&root);
        let run = |args: &[&str]| {
            let (_, err, code) = runner.run_raw(args, None, Duration::from_secs(5)).unwrap();
            assert_eq!(code, Some(0), "{err}");
        };
        run(&["init", "--initial-branch=review"]);
        std::fs::create_dir(root.join(".hack")).unwrap();
        std::fs::write(root.join(".hack/hack.config.json"), "{}").unwrap();
        std::fs::write(root.join(".hack/notes.txt"), "fixture").unwrap();
        std::fs::write(root.join("unrelated.txt"), "fixture").unwrap();
        run(&["add", "--", ".hack/hack.config.json"]);
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
