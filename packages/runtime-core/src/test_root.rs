//! Fresh, uniquely named temporary roots for test fixtures.
//!
//! A root named only from the process ID and the wall clock is not unique inside one test
//! process. macOS reports `SystemTime` in whole microseconds and `node::now` counts
//! milliseconds, so tests that `cargo test` starts together on parallel threads can compute
//! the same name. A fixture that then creates its root non-exclusively (for example with the
//! recursive `state::private_directory`) shares it with another test, and the first fixture's
//! cleanup removes the root under the second.
//!
//! Every root from this module is named `<prefix>-<pid>-<sequence>`, where the sequence is
//! process-wide, and is made with one exclusive, non-recursive `mkdir`. A root is therefore
//! never shared with another fixture in this process, and a name that an earlier process with
//! the same ID left behind is skipped, never reused. Callers keep their own cleanup.

use std::{
    fs,
    io::ErrorKind,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

/// Names tried before giving up; only stale roots from an earlier process consume extra tries.
const ATTEMPTS: usize = 64;

/// Create a fresh root in `parent` with the permissions of `fs::create_dir` (0777 less umask).
pub(crate) fn unique_test_root(parent: &Path, prefix: &str) -> PathBuf {
    create(parent, prefix, 0o777)
}

/// Create a fresh root in `parent` with mode 0700 (less umask).
pub(crate) fn private_test_root(parent: &Path, prefix: &str) -> PathBuf {
    create(parent, prefix, 0o700)
}

fn create(parent: &Path, prefix: &str, mode: u32) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    create_fresh(parent, mode, || {
        format!(
            "{prefix}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )
    })
}

/// Create the first name from `next` that does not exist yet, with one exclusive `mkdir`.
fn create_fresh(parent: &Path, mode: u32, mut next: impl FnMut() -> String) -> PathBuf {
    for _ in 0..ATTEMPTS {
        let path = parent.join(next());
        match fs::DirBuilder::new().mode(mode).create(&path) {
            Ok(()) => return path,
            // Left behind by an earlier process with this ID: skip it, never reuse it.
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => panic!("E_TEST_ROOT_CREATE: {:?}", error.kind()),
        }
    }
    panic!("E_TEST_ROOT_EXHAUSTED: no fresh test root name");
}

#[cfg(test)]
mod tests {
    use super::{create_fresh, private_test_root, unique_test_root};
    use std::{
        collections::BTreeSet,
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        sync::{Arc, Barrier},
        thread,
    };

    fn parent(label: &str) -> PathBuf {
        private_test_root(
            &fs::canonicalize(std::env::temp_dir()).unwrap(),
            &format!("hack-test-root-{label}"),
        )
    }

    #[test]
    fn parallel_fixtures_receive_distinct_freshly_created_roots() {
        const FIXTURES: usize = 32;
        const ROOTS: usize = 8;
        let parent = parent("parallel");
        let start = Arc::new(Barrier::new(FIXTURES));
        // Release every fixture at once, as `cargo test` starts tests on parallel threads.
        let fixtures: Vec<_> = (0..FIXTURES)
            .map(|fixture| {
                let parent = parent.clone();
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    (0..ROOTS)
                        .map(|index| {
                            let root = if index % 2 == 0 {
                                private_test_root(&parent, "fixture")
                            } else {
                                unique_test_root(&parent, "fixture")
                            };
                            // Fresh: nothing is in it yet. Claimed: a marker only this
                            // fixture writes, so a shared root would hold two markers.
                            assert!(fs::read_dir(&root).unwrap().next().is_none());
                            fs::write(root.join(format!("{fixture}-{index}")), b"").unwrap();
                            (root, index % 2 == 0)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let roots: Vec<_> = fixtures
            .into_iter()
            .flat_map(|fixture| fixture.join().unwrap())
            .collect();
        let distinct: BTreeSet<_> = roots.iter().map(|(root, _)| root.clone()).collect();
        assert_eq!(distinct.len(), FIXTURES * ROOTS);
        for (root, private) in &roots {
            assert_eq!(root.parent().unwrap(), parent);
            assert_eq!(fs::read_dir(root).unwrap().count(), 1);
            if *private {
                let mode = fs::metadata(root).unwrap().permissions().mode();
                assert_eq!(mode & 0o077, 0);
            }
        }
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn a_root_left_by_an_earlier_process_is_skipped_and_never_reused() {
        let parent = parent("stale");
        // The first names in the sequence exist already, as a crashed earlier process with the
        // same ID would have left them.
        let stale: Vec<_> = (0..3)
            .map(|sequence| {
                let path = parent.join(format!("fixture-{sequence}"));
                fs::create_dir(&path).unwrap();
                fs::write(path.join("earlier-process"), b"").unwrap();
                path
            })
            .collect();
        let mut sequence = 0;
        let root = create_fresh(&parent, 0o700, || {
            sequence += 1;
            format!("fixture-{}", sequence - 1)
        });
        assert_eq!(root, parent.join("fixture-3"));
        assert!(fs::read_dir(&root).unwrap().next().is_none());
        for path in &stale {
            assert_eq!(fs::read_dir(path).unwrap().count(), 1);
        }
        fs::remove_dir_all(parent).unwrap();
    }
}
