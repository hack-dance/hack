#![cfg(feature = "installed-candidate")]
//! Exercise dispatch before installed-home discovery at the real binary boundary.
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt, symlink},
    path::PathBuf,
    process::{Command, Output},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "installed-setup-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self(root)
    }
    fn run(&self, home: &str, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_hack-native"))
            .arg("--candidate-root")
            .arg(self.0.join(home))
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HACK_NO_INTERACTIVE", "1")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn absent_home_can_be_inspected_and_refused_consent_creates_nothing() {
    let f = Fixture::new();
    let output = f.run("missing/child", &["runtime", "setup", "inspect", "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let inspection: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(inspection["protocol_version"], 1);
    assert_eq!(inspection["installation_state"], "not_set_up");
    assert!(!f.0.join("missing").exists());
    let declined = f.run(
        "missing/child",
        &["runtime", "setup", "--no-interactive", "--json"],
    );
    assert!(!declined.status.success());
    assert!(String::from_utf8_lossy(&declined.stderr).contains("E_INTERACTIVE_REQUIRED"));
    assert!(!f.0.join("missing").exists());
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        assert_eq!(inspection["state"], "unsupported_host");
        let unsupported = f.run(
            "missing/child",
            &["runtime", "setup", "--accept-downloads", "--no-interactive"],
        );
        assert!(!unsupported.status.success());
        assert!(String::from_utf8_lossy(&unsupported.stderr).contains("unsupported_host"));
        assert!(!f.0.join("missing").exists());
    }
}

#[test]
fn alias_and_existing_public_home_are_preserved() {
    let f = Fixture::new();
    let directory = f.0.join("public");
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
    symlink(&directory, f.0.join("alias")).unwrap();
    for name in ["public", "alias"] {
        let result = f.run(name, &["runtime", "setup", "inspect", "--json"]);
        assert!(result.status.success());
        let inspection: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(inspection["state"], "unsafe_home");
        assert_eq!(inspection["setup_only"], false);
    }
    assert_eq!(
        fs::metadata(directory).unwrap().permissions().mode() & 0o777,
        0o755
    );
}
