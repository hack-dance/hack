//! Wait for a re-exec'd recovery publisher to write its marker.
use std::{
    path::Path,
    process::Child,
    thread,
    time::{Duration, Instant},
};

const PUBLICATION_WAIT_LOCAL: Duration = Duration::from_secs(15);
const PUBLICATION_WAIT_CI: Duration = Duration::from_secs(30);

// Bound for waiting on the re-exec'd publisher child. That child has to load this
// test binary before it can write `published`; a loaded macOS CI runner has taken
// more than 5 s to do that. `HACK_TEST_PUBLICATION_WAIT_SECS` raises the bound.
pub(crate) fn publication_wait() -> Duration {
    publication_wait_from(
        std::env::var("HACK_TEST_PUBLICATION_WAIT_SECS")
            .ok()
            .as_deref(),
        std::env::var_os("CI").is_some(),
    )
}

fn publication_wait_from(secs: Option<&str>, ci: bool) -> Duration {
    secs.and_then(|value| value.parse().ok())
        .filter(|&secs| secs > 0)
        .map(Duration::from_secs)
        .unwrap_or(if ci {
            PUBLICATION_WAIT_CI
        } else {
            PUBLICATION_WAIT_LOCAL
        })
}

pub(crate) fn wait_until_published(
    marker: &Path,
    child: &mut Child,
    wait: Duration,
    diagnostic: impl Fn() -> String,
) {
    let started = Instant::now();
    while !marker.exists() {
        if let Some(status) = child.try_wait().unwrap() {
            // Fixture::dead() writes the marker and exits. That can happen
            // between exists() and try_wait; only fail if the marker is still gone.
            if marker.exists() {
                return;
            }
            panic!(
                "publisher exited ({status}) before fixture publication after {:?}\n{}",
                started.elapsed(),
                diagnostic()
            );
        }
        assert!(
            started.elapsed() < wait,
            "fixture publication did not settle after {:?} (bound {wait:?}; publisher pid {} still running)\n{}",
            started.elapsed(),
            child.id(),
            diagnostic()
        );
        thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(test)]
mod tests {
    use super::{publication_wait, publication_wait_from, wait_until_published};
    use std::{
        fs,
        process::{Command, Stdio},
        time::Duration,
    };

    struct OwnedRoot(std::path::PathBuf);
    impl Drop for OwnedRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    struct OwnedChild(std::process::Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn root() -> OwnedRoot {
        OwnedRoot(crate::private_test_root(
            &fs::canonicalize(std::env::temp_dir()).unwrap(),
            "publication-wait",
        ))
    }

    #[test]
    fn publication_wait_uses_ci_or_local_default_and_positive_override() {
        assert_ne!(publication_wait(), Duration::ZERO);
        assert_eq!(publication_wait_from(None, false), Duration::from_secs(15));
        assert_eq!(publication_wait_from(None, true), Duration::from_secs(30));
        assert_eq!(
            publication_wait_from(Some("7"), false),
            Duration::from_secs(7)
        );
        assert_eq!(
            publication_wait_from(Some("0"), true),
            Duration::from_secs(30)
        );
        assert_eq!(
            publication_wait_from(Some("nope"), false),
            Duration::from_secs(15)
        );
    }

    #[test]
    fn wait_until_published_returns_once_the_marker_exists() {
        let root = root();
        let marker = root.0.join("published");
        let mut child = OwnedChild(
            Command::new("/bin/sh")
                .args([
                    "-c",
                    &format!(
                        "sleep 0.05; printf published > '{}'; exec sleep 30",
                        marker.display()
                    ),
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        wait_until_published(&marker, &mut child.0, Duration::from_secs(5), String::new);
        assert!(marker.exists());
        assert!(child.0.try_wait().unwrap().is_none());
    }

    #[test]
    fn wait_until_published_accepts_a_child_that_writes_then_exits() {
        let root = root();
        for index in 0..20 {
            let marker = root.0.join(format!("published-{index}"));
            let mut child = Command::new("/bin/sh")
                .args(["-c", &format!("printf published > '{}'", marker.display())])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            wait_until_published(&marker, &mut child, Duration::from_secs(5), String::new);
            assert!(marker.exists());
            assert!(child.wait().unwrap().success());
        }
    }

    #[test]
    fn wait_until_published_fails_fast_when_the_child_exits() {
        let root = root();
        let marker = root.0.join("published");
        // macOS has no /bin/true; /usr/bin/true exists on both hosts this suite runs.
        let mut child = Command::new("/usr/bin/true")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let started = std::time::Instant::now();
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            wait_until_published(&marker, &mut child, Duration::from_secs(15), || {
                "child-stderr".into()
            });
        }));
        let _ = child.wait();
        let error = panicked.expect_err("an exited publisher must fail the wait");
        let message = error
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| error.downcast_ref::<&str>().map(|text| (*text).to_string()))
            .unwrap_or_default();
        assert!(
            message.contains("publisher exited") && message.contains("child-stderr"),
            "{message}"
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn wait_until_published_times_out_while_the_child_is_still_running() {
        let root = root();
        let marker = root.0.join("published");
        let mut child = OwnedChild(
            Command::new("/bin/sleep")
                .arg("30")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let started = std::time::Instant::now();
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            wait_until_published(&marker, &mut child.0, Duration::from_millis(80), || {
                "still-running".into()
            });
        }));
        let error = panicked.expect_err("a live publisher past the bound must fail the wait");
        let message = error
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| error.downcast_ref::<&str>().map(|text| (*text).to_string()))
            .unwrap_or_default();
        assert!(
            message.contains("fixture publication did not settle")
                && message.contains("still-running")
                && message.contains("still running"),
            "{message}"
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(child.0.try_wait().unwrap().is_none());
    }
}
