//! Mandatory exclusions from the same policy used to generate init's ignore file.
use super::ignore::Rules;
use crate::CandidateError;
use crate::project::private_files::{POLICY, generated_state_child};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

pub(in crate::provider::image_build) struct PrivateFiles(Rules);

impl PrivateFiles {
    pub(in crate::provider::image_build) fn new() -> Result<Self, CandidateError> {
        // These shared patterns apply to immediate children of .hack. A directory
        // match prunes its entire subtree before user rules can re-include it.
        let rules = Rules::parse(POLICY.hack_dir_ignore.join("\n").as_bytes())?;
        assert!(!rules.fallback, "unsupported embedded private file pattern");
        Ok(Self(rules))
    }

    pub(super) fn excludes_child(
        &self,
        parent: Option<&OsStr>,
        name: &OsStr,
    ) -> Result<bool, CandidateError> {
        if name.eq_ignore_ascii_case(&POLICY.env_key)
            || name.eq_ignore_ascii_case(&POLICY.private_staging_dir)
            || parent.is_some_and(|parent| generated_state_child(parent, name))
        {
            return Ok(true);
        }
        if name.to_str().is_some_and(|name| {
            name.strip_prefix('.')
                .and_then(|name| name.strip_prefix(&POLICY.env_key))
                .is_some_and(|suffix| suffix.starts_with('.') && suffix.ends_with(".tmp"))
        }) {
            return Ok(true);
        }
        if !parent.is_some_and(|part| part.eq_ignore_ascii_case(".hack")) {
            return Ok(false);
        }
        // Materialize writes .env before writing its state file. An absent or
        // stale state file cannot prove the dotenv is safe to send.
        let name = name.to_string_lossy().to_ascii_lowercase();
        // Older versions wrote private dotenv staging files beside their target.
        let name = if name.starts_with("..env.") && name.ends_with(".tmp") {
            &name[1..]
        } else {
            &name
        };
        self.0.decide(name, &[]).map(|(excluded, _)| excluded)
    }

    pub(in crate::provider::image_build) fn excludes(
        &self,
        path: &Path,
    ) -> Result<bool, CandidateError> {
        let mut parent = None;
        for part in path.components() {
            if let Component::Normal(name) = part {
                if self.excludes_child(parent, name)? {
                    return Ok(true);
                }
                parent = Some(name);
            }
        }
        Ok(false)
    }

    pub(in crate::provider::image_build) fn copy_source(
        &self,
        context: &Path,
        source: &str,
    ) -> Result<bool, CandidateError> {
        // The frontend resolves COPY sources from / in the build context.
        let mut path = PathBuf::new();
        for part in Path::new(source).components() {
            match part {
                Component::Normal(name) => path.push(name),
                Component::ParentDir => {
                    path.pop();
                }
                _ => {}
            }
        }
        self.excludes(&context.join(path))
    }
}
