//! Explicit, bounded public normalization input; never a managed-secret transport.
use hack_runtime_core::{
    Candidate, CandidateError,
    project::{self, NormalizedComposeOptions, PlanOptions, PlanReport},
};
use std::{
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

const LIMIT: usize = 256 * 1024;
fn invalid() -> CandidateError {
    CandidateError::new(
        "normalized_cli_input",
        "Normalized input requires --normalized-file, --expect-original and --expect-namespace together; only project plan/capture/publish-source/verify-source and fresh graph run/serve support it. Public input must be a bounded, unchanged regular file; values omitted.",
    )
}

pub struct Selection<'a> {
    file: &'a str,
    original: &'a str,
    namespace: &'a str,
}
pub struct Input {
    bytes: Vec<u8>,
    original: String,
    namespace: String,
}

/// Remove only explicit normalization flags, preserving the existing command parser.
pub fn extract<'a>(
    args: &[&'a str],
    supported: bool,
) -> Result<(Vec<&'a str>, Option<Selection<'a>>), CandidateError> {
    let mut remaining = Vec::new();
    let (mut file, mut original, mut namespace) = (None, None, None);
    let mut index = 0;
    while index < args.len() {
        let key = args[index];
        index += 1;
        let slot = match key {
            "--normalized-file" => &mut file,
            "--expect-original" => &mut original,
            "--expect-namespace" => &mut namespace,
            _ => {
                remaining.push(key);
                continue;
            }
        };
        if !supported || slot.is_some() {
            return Err(invalid());
        }
        let value = *args.get(index).ok_or_else(invalid)?;
        index += 1;
        if value.is_empty() || value.starts_with("--") {
            return Err(invalid());
        }
        *slot = Some(value);
    }
    match (file, original, namespace) {
        (None, None, None) => Ok((remaining, None)),
        (Some(file), Some(original), Some(namespace)) if hex(original) && hex(namespace) => Ok((
            remaining,
            Some(Selection {
                file,
                original,
                namespace,
            }),
        )),
        _ => Err(invalid()),
    }
}
fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl Selection<'_> {
    pub fn load(&self) -> Result<Input, CandidateError> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(Path::new(self.file))
            .map_err(|_| invalid())?;
        let before = file.metadata().map_err(|_| invalid())?;
        if !before.is_file()
            || before.nlink() != 1
            || before.len() == 0
            || before.len() > LIMIT as u64
        {
            return Err(invalid());
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take((LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid())?;
        let after = file.metadata().map_err(|_| invalid())?;
        if bytes.len() as u64 != before.len()
            || after.len() != before.len()
            || after.mtime() != before.mtime()
            || after.mtime_nsec() != before.mtime_nsec()
            || after.ctime() != before.ctime()
            || after.ctime_nsec() != before.ctime_nsec()
        {
            return Err(invalid());
        }
        Ok(Input {
            bytes,
            original: self.original.to_owned(),
            namespace: self.namespace.to_owned(),
        })
    }
}
impl Input {
    pub fn options<'a>(&'a self, options: PlanOptions<'a>) -> NormalizedComposeOptions<'a> {
        NormalizedComposeOptions {
            project: options.project,
            compose_file: options.compose_file,
            profiles: options.profiles,
            expected_namespace: &self.namespace,
            expected_compose_sha256: &self.original,
            compose_bytes: &self.bytes,
        }
    }
}
pub fn review(
    candidate: &Candidate,
    options: PlanOptions<'_>,
    input: Option<&Input>,
) -> Result<PlanReport, CandidateError> {
    if let Some(input) = input {
        project::plan_normalized(candidate, input.options(options))
    } else {
        project::plan(candidate, options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    #[test]
    fn flags_are_complete_unique_explicit_and_action_scoped() {
        let hash = "a".repeat(64);
        let valid = [
            "--project",
            "app",
            "--normalized-file",
            "public.yml",
            "--expect-original",
            &hash,
            "--expect-namespace",
            &hash,
        ];
        let (remaining, selected) = extract(&valid, true).unwrap();
        assert_eq!(remaining, ["--project", "app"]);
        assert!(selected.is_some());
        assert!(extract(&valid, false).is_err());
        for flags in [
            &valid[..4],
            &valid[..6],
            &["--expect-original", "bad"][..],
            &["--normalized-file"][..],
        ] {
            assert!(extract(flags, true).is_err());
        }
        let mut duplicate = valid.to_vec();
        duplicate.extend(["--expect-original", &hash]);
        assert!(extract(&duplicate, true).is_err());
        assert!(
            extract(&["--file", "original.yml"], false)
                .unwrap()
                .1
                .is_none()
        );
    }
    #[test]
    fn files_are_bounded_regular_unaliased_and_errors_omit_values() {
        let root = std::env::temp_dir().join(format!(
            "hack-normalized-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("public.yml");
        let hash = "a".repeat(64);
        let selection = Selection {
            file: path.to_str().unwrap(),
            original: &hash,
            namespace: &hash,
        };
        fs::write(&path, "services: {}\n").unwrap();
        assert!(selection.load().is_ok());
        let hardlink = root.join("hardlink.yml");
        fs::hard_link(&path, &hardlink).unwrap();
        assert!(selection.load().is_err());
        fs::remove_file(hardlink).unwrap();
        fs::write(&path, vec![b'x'; LIMIT + 1]).unwrap();
        assert!(selection.load().is_err());
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink("PRIVATE_CANARY", &path).unwrap();
        let error = selection.load().err().unwrap();
        assert!(!error.message.contains("PRIVATE_CANARY"));
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(selection.load().is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
