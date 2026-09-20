#![cfg(target_os = "macos")]
//! Isolated process avoids unrelated test descriptors and exercises real libproc races.
use std::{path::PathBuf, process::Command};
struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[test]
fn socket_to_pipe_reuse_does_not_hide_a_stable_listener() {
    let scratch = Scratch(std::env::temp_dir().join(format!(
        "hack-fd-churn-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    )));
    std::fs::create_dir(&scratch.0).unwrap();
    let binary = scratch.0.join("probe");
    let compile = Command::new("cc")
        .args(["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-pthread"])
        .arg(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/loopback-descriptor-churn.c"),
        )
        .arg("-o")
        .arg(&binary)
        .output()
        .unwrap();
    assert!(
        compile.status.success(),
        "{}",
        String::from_utf8_lossy(&compile.stderr)
    );
    // The child self-expires after ten seconds and uses only its own loopback socket.
    let run = Command::new(&binary).output().unwrap();
    assert!(
        run.status.success(),
        "{} {}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
}
