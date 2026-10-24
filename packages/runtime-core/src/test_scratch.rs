//! Unique names for test scratch directories.

use std::sync::atomic::{AtomicU64, Ordering};

/// A sequence number unique within this test process, for scratch directory names.
///
/// Fixtures name a private temporary directory from the process ID and the wall clock, then
/// create it exclusively. The clock alone does not make the name unique: macOS reports it in
/// whole microseconds, so two parallel tests in one process can read the same value and the
/// second exclusive create fails with `File exists`. Appending this sequence keeps names apart.
pub(crate) fn next_test_scratch() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

mod tests {
    use std::{
        fs,
        os::unix::fs::DirBuilderExt,
        sync::{Arc, Barrier},
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn parallel_fixtures_reading_one_clock_tick_create_distinct_directories() {
        const FIXTURES: usize = 32;
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        let start = Arc::new(Barrier::new(FIXTURES));
        // Release every fixture at once so they read the clock together, then create the
        // directory exclusively as the module fixtures do.
        let fixtures: Vec<_> = (0..FIXTURES)
            .map(|_| {
                let base = base.clone();
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    let path = base.join(format!(
                        "hack-test-scratch-{}-{}-{}",
                        std::process::id(),
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap()
                            .as_nanos(),
                        super::next_test_scratch()
                    ));
                    let result = fs::DirBuilder::new().mode(0o700).create(&path);
                    (path, result)
                })
            })
            .collect();
        let mut failures = Vec::new();
        for fixture in fixtures {
            let (path, result) = fixture.join().unwrap();
            match result {
                Ok(()) => fs::remove_dir(&path).unwrap(),
                Err(error) => failures.push(format!("{}: {error}", path.display())),
            }
        }
        assert!(failures.is_empty(), "{failures:?}");
    }
}
