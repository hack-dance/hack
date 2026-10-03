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

/// Only the second legacy owner uses graceful retirement. Its registered
/// foreground signal handler must unwind the real managed transport owner even
/// when historical journal archival still refuses; PID death alone is not proof
/// that a reservation or socket may be released.
pub(super) fn graceful_stop(
    files: &Files,
    owner: &mut Process,
    process: &crate::provider::identity::ProcessIdentity,
    deadline: Instant,
) -> ExitStatus {
    let stage = "second-legacy-stop";
    write_new(&files.private.join(format!("{stage}.waiting")), b"").unwrap();
    let result = catch_unwind(AssertUnwindSafe(|| {
        assert!(
            owner.poll().is_none(),
            "selected legacy owner already exited"
        );
        assert_eq!(
            crate::provider::identity::observe(owner.child.id() as i32).unwrap(),
            *process,
            "selected legacy process changed"
        );
        // SAFETY: the retained, unreaped Child owns this exact PID; it cannot be
        // recycled. SIGTERM is handled by foreground::signals::Events.
        assert_eq!(unsafe { libc::kill(process.pid, libc::SIGTERM) }, 0);
        let status = owner.wait(deadline.min(Instant::now() + Duration::from_secs(20)));
        assert!(
            status.code().is_some(),
            "legacy signal handler did not exit normally"
        );
        assert!(!crate::provider::identity::alive(process.pid).unwrap());
        status
    }));
    for (suffix, bytes) in [("stdout", &owner.out), ("stderr", &owner.err)] {
        write_new(&files.private.join(format!("{stage}.{suffix}")), bytes).unwrap();
    }
    let status = match result {
        Ok(status) => status,
        Err(panic) => resume_unwind(panic),
    };
    write_new(&files.private.join(format!("{stage}.stopped")), b"").unwrap();
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::relay_owner::{
        Context,
        managed::{ManagedOwner, ManagedSlot},
    };
    use std::os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    };

    #[test]
    fn graceful_stop_uses_foreground_signals_and_real_owner_without_stealing_replacements() {
        const CHILD_ROOT: &str = "HACK_RETIRED_REBIND_STOP_TEST_ROOT";
        const CHILD_PRIVATE: &str = "HACK_RETIRED_REBIND_STOP_TEST_PRIVATE";
        const CHILD_SOCKET_HOME: &str = "HACK_RETIRED_REBIND_STOP_TEST_SOCKET_HOME";
        const CHILD_RUN: &str = "HACK_RETIRED_REBIND_STOP_TEST_RUN";
        if let Some(root) = std::env::var_os(CHILD_ROOT) {
            let candidate = Candidate::discover(Path::new(&root)).unwrap();
            let private = PathBuf::from(std::env::var_os(CHILD_PRIVATE).unwrap());
            let socket_home = PathBuf::from(std::env::var_os(CHILD_SOCKET_HOME).unwrap());
            let run = std::env::var(CHILD_RUN).unwrap();
            let mut publication = transport::Publication::bind(&candidate, &run).unwrap();
            let events = super::super::super::super::signals::Events::new(&publication).unwrap();
            let control = socket_home.join("owner-control");
            state::private_directory(&control).unwrap();
            let managed = ManagedOwner::start(
                Context {
                    runtime: [1; 16],
                    boot: [2; 16],
                },
                &control,
                vec![ManagedSlot {
                    slot: 0,
                    path: socket_home.join("dependency-00.sock"),
                    canonical_parent: socket_home.clone(),
                }],
            )
            .unwrap();
            managed.verify_alive().unwrap();
            write_new(&private.join("owner-ready"), b"").unwrap();
            // wait reports EVFILT_SIGNAL directly; the process-wide pending
            // flag is an independent fast path, not a required postcondition.
            assert!(events.wait().unwrap());
            // Exercise the same production Drop that a legacy archival refusal
            // reaches after its foreground SIGTERM handler returns.
            drop(managed);
            publication.finish().unwrap();
            return;
        }
        for replacement in [false, true] {
            let parent = graph::tests::Fixture::new();
            let candidate = Candidate::discover(&parent.0).unwrap();
            let files = Files::new(&candidate.checkout);
            let run = graph::probes::token().unwrap();
            // Use an owned short control directory, as the real managed owner
            // does; macOS Unix addresses cannot hold the host's full TMPDIR.
            let socket_home = PathBuf::from(format!("/private/tmp/hkrr-{}", &run[..16]));
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&socket_home)
                .unwrap();
            let sibling = socket_home.join("sibling.sock");
            let sibling_listener = UnixListener::bind(&sibling).unwrap();
            let sibling_inode = fs::symlink_metadata(&sibling).unwrap().ino();
            let child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "provider::graph::foreground::native_test::retired_rebind_history::fixture::tests::graceful_stop_uses_foreground_signals_and_real_owner_without_stealing_replacements",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(CHILD_ROOT, &candidate.checkout)
                .env(CHILD_PRIVATE, &files.private)
                .env(CHILD_SOCKET_HOME, &socket_home)
                .env(CHILD_RUN, &run)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn().unwrap();
            let mut owner = Process {
                child,
                out: Vec::new(),
                err: Vec::new(),
            };
            nonblocking(owner.child.stdout.as_ref().unwrap().as_raw_fd());
            nonblocking(owner.child.stderr.as_ref().unwrap().as_raw_fd());
            let deadline = Instant::now() + Duration::from_secs(10);
            while !files.private.join("owner-ready").exists() {
                assert!(
                    owner.poll().is_none(),
                    "owned signal test exited: {}",
                    String::from_utf8_lossy(&owner.err)
                );
                assert!(
                    Instant::now() < deadline,
                    "owned signal test readiness deadline"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            let process = crate::provider::identity::observe(owner.child.id() as i32).unwrap();
            let socket = socket_home.join("dependency-00.sock");
            let replacement_listener = replacement.then(|| {
                fs::rename(&socket, socket_home.join("displaced-owned.sock")).unwrap();
                UnixListener::bind(&socket).unwrap()
            });
            let inode = fs::symlink_metadata(&socket).unwrap().ino();
            assert!(
                graceful_stop(&files, &mut owner, &process, deadline).success(),
                "{}",
                String::from_utf8_lossy(&owner.err)
            );
            if replacement {
                assert_eq!(fs::symlink_metadata(&socket).unwrap().ino(), inode);
                assert!(UnixStream::connect(&socket).is_ok());
                assert!(socket_home.join("displaced-owned.sock").exists());
            } else {
                assert_eq!(
                    fs::symlink_metadata(&socket).unwrap_err().kind(),
                    io::ErrorKind::NotFound
                );
            }
            assert_eq!(fs::symlink_metadata(&sibling).unwrap().ino(), sibling_inode);
            assert!(UnixStream::connect(&sibling).is_ok());
            assert!(files.private.join("second-legacy-stop.stopped").exists());
            drop(replacement_listener);
            drop(sibling_listener);
            // The child's Publication::finish already removed its endpoint names.
            // Dispose only this test's now-empty publication directory/lock.
            fs::remove_dir_all(transport::root(&candidate, &run).unwrap()).unwrap();
            fs::remove_dir_all(socket_home).unwrap();
            files.dispose().unwrap();
        }
    }

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
