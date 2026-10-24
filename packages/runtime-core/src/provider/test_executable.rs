use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    process::{Child, Command, Stdio},
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

/// Test bound for one whole-host `lsof` scan. `lsof` walks every process on the host, so
/// on a loaded machine with other tests scanning at the same time one scan can take well
/// over its production budget (HACK-1457: over 5 s at load average ~80-120 with process
/// spawn churn). Only a scan that never finishes should reach this; it stays well inside
/// [`ISOLATED_HANG_GUARD`], so an isolated fixture still reports its own failure.
pub(super) const LOADED_HOST_SCAN_WAIT: Duration = Duration::from_secs(60);

/// Hang guard for [`run_isolated`]: the child launches the whole test binary on a host that
/// may be heavily loaded, so this bounds a hang rather than the fixture's own timing.
pub(super) const ISOLATED_HANG_GUARD: Duration = Duration::from_secs(120);

/// Run one ignored test alone in a child process of this test binary and require its
/// complete assertion path. Use it when a fixture's descriptors must not be shared with
/// unrelated parallel tests: their pre-exec forks (`process::clean_command`) hold copies
/// of every descriptor of this process until they exec, so a whole-host process scan or
/// an `flock` release can observe this test's sockets, files or locks in another
/// process. `bound` is a hang guard for launching the whole binary on a loaded host.
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
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let started = Instant::now();
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
    let mut output = String::new();
    child
        .0
        .stdout
        .take()
        .unwrap()
        .take(4097)
        .read_to_string(&mut output)
        .unwrap();
    assert!(output.len() <= 4096);
    assert!(status.success(), "isolated test {test} failed: {output}");
    assert!(
        output.contains(&format!("test {test} ... ok"))
            && output.contains("test result: ok. 1 passed"),
        "isolated test {test} assertions did not run: {output}"
    );
}
