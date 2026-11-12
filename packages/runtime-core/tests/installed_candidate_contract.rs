#![cfg(feature = "installed-candidate")]

use hack_runtime_core::Candidate;
use serde_json::Value;
use std::fs;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

static NEXT_FIXTURE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-installed-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }
    fn directory(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn invoke(binary: &Path, home: &Path, cwd: &Path, args: &[&str]) -> Output {
    Command::new(binary)
        .arg("--candidate-root")
        .arg(home)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/nonexistent")
        .env("HOME", cwd)
        .env("HACK_HOME", "/must-not-be-used")
        .env("DOCKER_HOST", "unix:///must-not-be-contacted")
        .output()
        .unwrap()
}

#[test]
fn copied_installed_binary_uses_only_explicit_home_and_preserves_reexec_identity() {
    let fixture = Fixture::new();
    let bundle = fixture.directory("copied-bundle");
    let home = fixture.directory("stable-home");
    let cwd = fixture.directory("unrelated-cwd");
    let binary = bundle.join("hack-native");
    fs::copy(env!("CARGO_BIN_EXE_hack-native"), &binary).unwrap();
    let output = invoke(&binary, &home, &cwd, &["info", "--json"]);
    assert!(output.status.success(), "{output:?}");
    let identity: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(identity["channel"], "installed-candidate");
    assert_eq!(identity["checkout"], home.to_str().unwrap());
    assert_eq!(
        identity["state_root"],
        home.join(".hack-local").to_str().unwrap()
    );
    let executable = Path::new(identity["executable"].as_str().unwrap());
    assert_eq!(executable, binary);
    // The same executable/root pair passed by supervisors works after relocation.
    let version = invoke(
        executable,
        Path::new(identity["checkout"].as_str().unwrap()),
        &cwd,
        &["--version"],
    );
    assert!(version.status.success(), "{version:?}");
    assert!(
        String::from_utf8(version.stdout)
            .unwrap()
            .starts_with("hack-native ")
    );
    let plan = invoke(
        &binary,
        &home,
        &cwd,
        &["plan", "--project", cwd.to_str().unwrap(), "--json"],
    );
    assert!(plan.status.success(), "{plan:?}");
    assert_eq!(fs::read_dir(&home).unwrap().count(), 0);
    assert_eq!(fs::read_dir(&cwd).unwrap().count(), 0);
}

#[test]
fn quiescent_https_recovery_requires_exact_selectors_without_initializing_state() {
    let fixture = Fixture::new();
    let home = fixture.directory("private");
    let cwd = fixture.directory("cwd");
    for (owner, pid) in [
        ("wrong", "999999"),
        (
            "0000000000000000000000000000000000000000000000000000000000000000",
            "1",
        ),
    ] {
        let output = invoke(
            Path::new(env!("CARGO_BIN_EXE_hack-native")),
            &home,
            &cwd,
            &[
                "runtime",
                "recover-quiescent-https",
                "--expect-owner",
                owner,
                "--expect-configuration",
                "1111111111111111111111111111111111111111111111111111111111111111",
                "--expect-frontend-pid",
                pid,
                "--json",
            ],
        );
        assert!(!output.status.success());
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("https_recovery_refused")
        );
        assert_eq!(fs::read_dir(&home).unwrap().count(), 0);
    }
}

#[test]
fn installed_entrypoint_refuses_public_missing_relative_and_aliased_homes() {
    let fixture = Fixture::new();
    let home = fixture.directory("private");
    let alias = fixture.0.join("alias");
    symlink(&home, &alias).unwrap();
    let child = home.join("nested");
    fs::DirBuilder::new().mode(0o700).create(&child).unwrap();
    let public = fixture.directory("public");
    fs::set_permissions(&public, fs::Permissions::from_mode(0o755)).unwrap();
    let paths: [&Path; 5] = [
        &public,
        &alias,
        &alias.join("nested"),
        &fixture.0.join("absent"),
        Path::new("private"),
    ];
    for path in paths {
        let output = invoke(
            Path::new(env!("CARGO_BIN_EXE_hack-native")),
            path,
            &fixture.0,
            &["--version"],
        );
        assert_eq!(output.status.code(), Some(2), "{output:?}");
        assert!(output.stdout.is_empty());
    }
    symlink(&public, home.join(".hack-local")).unwrap();
    assert_eq!(
        Candidate::discover_installed(&home).unwrap_err().code,
        "aliased_state"
    );
}

#[test]
fn installed_home_still_refuses_overlapping_source() {
    let fixture = Fixture::new();
    let home = fixture.directory("home");
    let candidate = Candidate::discover_installed(&home).unwrap();
    assert_eq!(
        candidate.plan(&home).unwrap_err().code,
        "overlapping_workspace"
    );
    assert_eq!(
        candidate.plan(&fixture.0).unwrap_err().code,
        "overlapping_workspace"
    );
}

#[test]
fn project_plan_reports_shared_start_refusals_without_runtime_effects() {
    use serde_json::json;
    let fixture = Fixture::new();
    let project = fixture.directory("project");
    let candidate = fixture.directory("candidate");
    let home = fixture.directory("fake-home");
    let config = fixture.directory("config");
    let state = fixture.directory("state");
    let cache = fixture.directory("cache");
    let data = fixture.directory("data");
    let empty_path = fixture.directory("empty-path");
    let image = format!("sha256:{}", "a".repeat(64));
    let base = json!({"image": image});
    let mut udp = base.clone();
    udp["ports"] = json!(["8787:3000/udp"]);
    let mut disabled_health = base.clone();
    disabled_health["healthcheck"] = json!({"disable":true});
    let mut limited = base.clone();
    limited["deploy"] = json!({"resources":{"limits":{"cpus":"2"}}});
    let cases = [
        (
            json!({"services":{"web":udp}}),
            Some("graph_port_publication"),
        ),
        (
            json!({"services":{"web":{"image":image,"ports":[{"target":3000,"published":8787,"protocol":"udp"}]}}}),
            Some("graph_port_publication"),
        ),
        (
            json!({"services":{"web":base,"worker":{"image":image,"profiles":["worker"],"ports":["8787:3000/udp"]}}}),
            None,
        ),
        (
            json!({"services":{"job":disabled_health}}),
            Some("graph_readiness"),
        ),
        (
            json!({"services":{"a":limited,"b":limited,"c":limited}}),
            Some("graph_budget"),
        ),
    ];
    for (document, expected) in cases {
        std::fs::write(
            project.join("compose.json"),
            serde_json::to_vec(&document).unwrap(),
        )
        .unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_hack-native"))
            .arg("--candidate-root")
            .arg(&candidate)
            .args(["project", "plan", "--project"])
            .arg(&project)
            .args(["--file", "compose.json", "--json"])
            .env_clear()
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", &config)
            .env("XDG_STATE_HOME", &state)
            .env("XDG_CACHE_HOME", &cache)
            .env("XDG_DATA_HOME", &data)
            .env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .env("HACK_NO_INTERACTIVE", "1")
            .env("PATH", &empty_path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        let refusals = report["start_refusals"].as_array().unwrap();
        if let Some(code) = expected {
            assert!(
                refusals.iter().any(|r| r["code"] == code),
                "missing {code}: {report}"
            );
            let refusal = refusals.iter().find(|r| r["code"] == code).unwrap();
            assert_eq!(refusal["message_fixed"], true);
            if code == "graph_port_publication" {
                assert_eq!(refusal["service"], "web");
                assert_eq!(
                    refusal["message"],
                    "Native publishes only TCP ports; keep UDP publication on the Compose backend."
                );
            }
        } else {
            assert!(refusals.is_empty(), "{refusals:?}");
        }
        assert_eq!(std::fs::read_dir(&candidate).unwrap().count(), 0);
    }
}
