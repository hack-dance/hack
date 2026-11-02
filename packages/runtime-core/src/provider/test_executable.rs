use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    process::{Child, Command, Stdio},
    thread::JoinHandle,
    time::{Duration, Instant},
};

/// Build a finite owned test process instead of copying an Apple platform binary,
/// which can die before a process-identity or quiescence observation. Callers keep
/// their original duration arguments and exact child ownership/cleanup checks.
// Only the macOS-only process-identity tests use it; `run_isolated` is used on every Unix.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) fn sleeping_executable(binary: &Path) {
    assert!(!binary.try_exists().unwrap());
    let source = binary.with_extension("c");
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&source)
        .unwrap();
    file.write_all(
        b"#include <stdlib.h>\n#include <unistd.h>\n\
          int main(int argc, char **argv) {\n\
          if (argc != 2) return 2;\n\
          char *end = 0; unsigned long seconds = strtoul(argv[1], &end, 10);\n\
          if (*end || seconds == 0 || seconds > 120) return 2;\n\
          sleep((unsigned int)seconds); return 0;\n}\n",
    )
    .unwrap();
    drop(file);
    assert!(
        Command::new("cc")
            .args(["-std=c11", "-Wall", "-Wextra", "-Werror"])
            .arg(&source)
            .arg("-o")
            .arg(binary)
            .status()
            .unwrap()
            .success()
    );
    fs::set_permissions(binary, fs::Permissions::from_mode(0o700)).unwrap();
}

/// Hang guard for [`run_isolated`]: the child launches the whole test binary on a host that
/// may be heavily loaded, so this bounds a hang rather than the fixture's own timing.
pub(super) const ISOLATED_HANG_GUARD: Duration = Duration::from_secs(120);

/// Bytes of each child stream kept for a failure message. The readers always drain the
/// whole stream, so the child is never blocked on a full pipe; only the tail, where libtest
/// prints the failing assertion and the result line, is retained.
const RETAINED_TAIL: usize = 16 * 1024;

/// Largest stdout a passing child may print: one isolated test's libtest summary is far
/// smaller, so more means the child ran something other than the requested fixture.
const PASSING_STDOUT_LIMIT: usize = 4096;

/// One child stream drained to its end on a reader thread, keeping a bounded tail.
struct DrainedStream {
    tail: Vec<u8>,
    total: usize,
}

impl DrainedStream {
    fn spawn(mut source: impl Read + Send + 'static) -> JoinHandle<Self> {
        std::thread::spawn(move || {
            let mut drained = Self {
                tail: Vec::new(),
                total: 0,
            };
            let mut chunk = [0_u8; 8192];
            loop {
                match source.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => {
                        drained.total += read;
                        drained.tail.extend_from_slice(&chunk[..read]);
                        let excess = drained.tail.len().saturating_sub(RETAINED_TAIL);
                        drained.tail.drain(..excess);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }
            drained
        })
    }

    fn text(&self) -> String {
        let omitted = self.total - self.tail.len();
        let tail = String::from_utf8_lossy(&self.tail);
        if omitted == 0 {
            tail.into_owned()
        } else {
            format!("[{omitted} earlier bytes omitted]\n{tail}")
        }
    }
}

/// Run one ignored test alone in a child process of this test binary and require its
/// complete assertion path. Use it when a fixture's descriptors must not be shared with
/// unrelated parallel tests: their pre-exec forks (`process::clean_command`) hold copies
/// of every descriptor of this process until they exec, so a whole-host process scan or
/// an `flock` release can observe this test's sockets, files or locks in another
/// process. `bound` is a hang guard for launching the whole binary on a loaded host.
///
/// The child's stdout and stderr are drained on reader threads while it runs: a child
/// that fails with more output than a pipe buffer holds must exit and report its own
/// failure, not block on a write until the hang guard reports a watchdog instead. The
/// bound covers both the child's exit and the readers reaching end of stream, so a
/// descendant that keeps a copy of either pipe open is reported rather than waited on.
pub(super) fn run_isolated(test: &str, bound: Duration) {
    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", test, "--test-threads=1"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let started = Instant::now();
    let stdout = DrainedStream::spawn(child.0.stdout.take().unwrap());
    let stderr = DrainedStream::spawn(child.0.stderr.take().unwrap());
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        assert!(
            started.elapsed() < bound,
            "isolated test {test} exceeded its watchdog after {:?}",
            started.elapsed()
        );
        std::thread::sleep(Duration::from_millis(1));
    };
    while !(stdout.is_finished() && stderr.is_finished()) {
        assert!(
            started.elapsed() < bound,
            "isolated test {test} exited with {status} but its output stayed open past its \
             watchdog after {:?}",
            started.elapsed()
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    let stdout = stdout.join().unwrap();
    let stderr = stderr.join().unwrap();
    let (output, errors) = (stdout.text(), stderr.text());
    assert!(
        status.success(),
        "isolated test {test} failed with {status}\n--- stdout ---\n{output}\n--- stderr ---\n{errors}"
    );
    assert!(
        stdout.total <= PASSING_STDOUT_LIMIT
            && output.contains(&format!("test {test} ... ok"))
            && output.contains("test result: ok. 1 passed"),
        "isolated test {test} assertions did not run\n--- stdout ---\n{output}\n--- stderr ---\n{errors}"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// More than a 64 KiB pipe buffer on each stream, so an unread pipe blocks the child.
    const NOISY_BYTES: usize = 160 * 1024;
    const NOISY_FAILURE: &str = "noisy isolated child failed on purpose";
    const NOISY_STDERR_END: &str = "noisy isolated child stderr end";

    #[test]
    #[ignore = "deliberately failing child launched by isolated_child_failure_with_large_output_is_reported"]
    fn noisy_failure_child() {
        let line = "x".repeat(1023);
        // libtest captures this and prints it with the failure, on stdout, before the panic.
        for _ in 0..NOISY_BYTES / 1024 {
            println!("{line}");
        }
        // Direct writes bypass libtest's capture and reach the stderr pipe as written.
        let mut stderr = std::io::stderr().lock();
        for _ in 0..NOISY_BYTES / 1024 {
            writeln!(stderr, "{line}").unwrap();
        }
        writeln!(stderr, "{NOISY_STDERR_END}").unwrap();
        drop(stderr);
        panic!("{NOISY_FAILURE}");
    }

    /// A child whose failure output overflows both pipes must still exit and report its own
    /// failure: an unread pipe would block it until the hang guard hid the real failure
    /// behind a watchdog panic.
    #[test]
    fn isolated_child_failure_with_large_output_is_reported() {
        let test = "provider::test_executable::tests::noisy_failure_child";
        let started = Instant::now();
        let panic = std::panic::catch_unwind(|| run_isolated(test, ISOLATED_HANG_GUARD))
            .expect_err("a failing isolated child must fail its parent");
        let message = panic.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(
            started.elapsed() < ISOLATED_HANG_GUARD,
            "{:?}",
            started.elapsed()
        );
        assert!(!message.contains("watchdog"), "{message}");
        assert!(
            message.starts_with(&format!("isolated test {test} failed with ")),
            "{message}"
        );
        assert!(message.contains(NOISY_FAILURE), "{message}");
        assert!(message.contains(NOISY_STDERR_END), "{message}");
        assert!(message.contains("earlier bytes omitted"), "{message}");
        assert!(message.len() < 3 * RETAINED_TAIL, "{}", message.len());
    }
}
