//! This regression keeps its inputs on unwind. Only its verified success path
//! disposes them; graph/VM cleanup remains explicit in the caller.
use super::*;
use std::{
    io,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    panic::{AssertUnwindSafe, catch_unwind, resume_unwind},
};

pub(super) struct Files {
    root: PathBuf,
    identities: Vec<(PathBuf, u64, u64)>,
    pub(super) selected: PathBuf,
    pub(super) sibling: PathBuf,
    pub(super) private: PathBuf,
}

impl Files {
    pub(super) fn new(parent: &Path) -> Self {
        let root = parent.join(format!(
            "retired-rebind-fixture-{}",
            graph::probes::token().unwrap()
        ));
        let selected = root.join("selected");
        let sibling = root.join("sibling");
        let private = root.join("private");
        let mut identities = Vec::new();
        for path in [&root, &selected, &sibling, &private] {
            fs::DirBuilder::new().mode(0o700).create(path).unwrap();
            let metadata = fs::symlink_metadata(path).unwrap();
            identities.push((path.clone(), metadata.dev(), metadata.ino()));
        }
        Self {
            root,
            identities,
            selected,
            sibling,
            private,
        }
    }

    pub(super) fn dispose(self) -> io::Result<()> {
        for (path, device, inode) in &self.identities {
            let metadata = fs::symlink_metadata(path)?;
            if !metadata.is_dir() || (metadata.dev(), metadata.ino()) != (*device, *inode) {
                return Err(io::Error::other("owned fixture directory changed"));
            }
        }
        fs::remove_dir_all(&self.root)
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}

pub(super) fn ready_at(
    stage: &str,
    files: &Files,
    owner: &mut Process,
    run: &str,
    deadline: Instant,
) {
    // The four callers supply fixed stage names. These private files retain the
    // bounded foreground pipes before unwinding can retire the owned child.
    eprintln!("retired-rebind stage={stage} waiting");
    write_new(&files.private.join(format!("{stage}.waiting")), b"").unwrap();
    let result = catch_unwind(AssertUnwindSafe(|| ready(owner, run, deadline)));
    if let Err(panic) = result {
        eprintln!("retired-rebind stage={stage} failed");
        for (suffix, bytes) in [("stdout", &owner.out), ("stderr", &owner.err)] {
            if let Err(error) = write_new(&files.private.join(format!("{stage}.{suffix}")), bytes) {
                eprintln!("retired-rebind stage={stage} diagnostic write failed: {error}");
            }
        }
        resume_unwind(panic);
    }
    write_new(&files.private.join(format!("{stage}.ready")), b"").unwrap();
    eprintln!("retired-rebind stage={stage} ready");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn inputs(files: &Files) -> Vec<(PathBuf, Vec<u8>, u64)> {
        [
            files.selected.join("compose.yaml"),
            files.sibling.join("compose.yaml"),
            files.private.join("selected-dependencies.json"),
            files.private.join("prior-owner.json"),
        ]
        .into_iter()
        .map(|path| {
            let bytes = path.file_name().unwrap().as_encoded_bytes().to_vec();
            write_new(&path, &bytes).unwrap();
            let inode = fs::symlink_metadata(&path).unwrap().ino();
            (path, bytes, inode)
        })
        .collect()
    }

    #[test]
    fn unwind_preserves_inputs_and_foreground_failure_diagnostics() {
        let parent = graph::tests::Fixture::new();
        let candidate = Candidate::discover(&parent.0).unwrap();
        let files = Files::new(&candidate.checkout);
        let preserved = inputs(&files);
        let private = files.private.clone();
        let binary = private.join("refused-cli");
        write_new(
            &binary,
            b"#!/bin/sh\nprintf '{\"code\":\"dependency_reservation\"}\\n' >&2\nexit 2\n",
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        let failed = catch_unwind(AssertUnwindSafe(move || {
            let mut owner = Process::start(&binary, &candidate, &[], None);
            ready_at(
                "first-legacy-restore",
                &files,
                &mut owner,
                "fixture-run",
                Instant::now() + Duration::from_secs(5),
            );
        }));
        assert!(failed.is_err());
        for (path, bytes, inode) in preserved {
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(fs::symlink_metadata(path).unwrap().ino(), inode);
        }
        assert!(private.join("first-legacy-restore.waiting").exists());
        assert!(!private.join("first-legacy-restore.ready").exists());
        assert_eq!(
            fs::read(private.join("first-legacy-restore.stderr")).unwrap(),
            b"{\"code\":\"dependency_reservation\"}\n"
        );
    }

    #[test]
    fn explicit_success_disposal_removes_only_owned_inputs() {
        let parent = graph::tests::Fixture::new();
        let sentinel = parent.0.join("other-owner-data");
        write_new(&sentinel, b"preserved").unwrap();
        let files = Files::new(&parent.0);
        let paths = inputs(&files);
        let root = files.root.clone();
        files.dispose().unwrap();
        assert!(!root.exists());
        for (path, _, _) in paths {
            assert!(!path.exists());
        }
        assert_eq!(fs::read(sentinel).unwrap(), b"preserved");
    }

    #[test]
    fn disposal_refuses_replaced_directory_and_preserves_originals() {
        let parent = graph::tests::Fixture::new();
        let files = Files::new(&parent.0);
        let preserved = inputs(&files);
        let original = files.root.join("original-private");
        fs::rename(&files.private, &original).unwrap();
        fs::create_dir(&files.private).unwrap();
        write_new(&files.private.join("other-owner-data"), b"preserved").unwrap();
        let replacement = files.private.clone();
        assert!(files.dispose().is_err());
        assert_eq!(
            fs::read(replacement.join("other-owner-data")).unwrap(),
            b"preserved"
        );
        for (path, bytes, inode) in preserved {
            let path = if path.parent() == Some(replacement.as_path()) {
                original.join(path.file_name().unwrap())
            } else {
                path
            };
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(fs::symlink_metadata(path).unwrap().ino(), inode);
        }
    }
}
