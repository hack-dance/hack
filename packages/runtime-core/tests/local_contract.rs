use hack_runtime_core::Candidate;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hack-core-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }

    fn directory(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        std::fs::create_dir_all(&path).unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn checkout() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn invoke(fixture: &Fixture, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate"))
        .arg("--candidate-root")
        .arg(checkout())
        .args(arguments)
        .current_dir(&fixture.0)
        .env_clear()
        .env("HOME", fixture.directory("fake-home"))
        .env("DOCKER_HOST", "unix:///must-not-be-contacted/docker.sock")
        .env("HACK_HOME", "/must-not-be-used")
        .env("HACK_DAEMON_URL", "http://127.0.0.1:1")
        .env("PATH", fixture.directory("empty-path"))
        .output()
        .unwrap()
}

#[test]
fn plan_is_read_only_and_does_not_consume_credentials_or_global_runtime() {
    let fixture = Fixture::new();
    let project = fixture.directory("real project Ω");
    let source = project.join(".env");
    std::fs::write(&source, "SYNTHETIC_SECRET=must-not-appear-in-plan\n").unwrap();
    let output = invoke(
        &fixture,
        &["plan", "--project", project.to_str().unwrap(), "--json"],
    );
    assert!(output.status.success(), "{:?}", output);
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(!text.contains("must-not-appear-in-plan"));
    let plan: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(plan["runtime_execution_supported"], false);
    assert_eq!(plan["project_configuration_loaded"], false);
    assert_eq!(plan["effects"], serde_json::json!([]));
    assert_eq!(plan["source"], project.to_str().unwrap());
    assert_eq!(std::fs::read_dir(&project).unwrap().count(), 1);
    assert_eq!(
        std::fs::read_dir(fixture.0.join("fake-home"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(
        std::fs::read_to_string(source).unwrap(),
        "SYNTHETIC_SECRET=must-not-appear-in-plan\n"
    );
    for path in plan["planned_paths"].as_object().unwrap().values() {
        assert!(Path::new(path.as_str().unwrap()).starts_with(checkout().join(".hack-local")));
    }
}

#[test]
fn separate_checkouts_and_projects_have_separate_planned_state() {
    let fixture = Fixture::new();
    let left = Candidate::discover(&fixture.directory("candidate-a")).unwrap();
    let right = Candidate::discover(&fixture.directory("candidate-b")).unwrap();
    let project_a = fixture.directory("project-a");
    let project_b = fixture.directory("project-b");
    let first = left.plan(&project_a).unwrap();
    assert_eq!(first.namespace, left.plan(&project_a).unwrap().namespace);
    assert_ne!(first.namespace, left.plan(&project_b).unwrap().namespace);
    assert_ne!(
        first.planned_paths.workspace_state,
        right
            .plan(&project_a)
            .unwrap()
            .planned_paths
            .workspace_state
    );
    assert!(!left.state_root.exists());
    assert!(!right.state_root.exists());
}

#[test]
fn missing_and_overlapping_projects_are_rejected() {
    let fixture = Fixture::new();
    let candidate = Candidate::discover(&fixture.directory("candidate")).unwrap();
    assert_eq!(
        candidate.plan(&fixture.0.join("absent")).unwrap_err().code,
        "invalid_directory"
    );
    assert_eq!(
        candidate.plan(&candidate.checkout).unwrap_err().code,
        "overlapping_workspace"
    );
    assert_eq!(
        candidate.plan(&fixture.0).unwrap_err().code,
        "overlapping_workspace"
    );
    let inner = candidate.state_root.join("source");
    std::fs::create_dir_all(&inner).unwrap();
    assert_eq!(
        candidate.plan(&inner).unwrap_err().code,
        "overlapping_workspace"
    );
}

#[test]
fn mutation_commands_fail_instead_of_falling_back_to_v4() {
    let fixture = Fixture::new();
    for command in ["up", "down", "exec", "sync", "init", "install"] {
        let output = invoke(&fixture, &[command]);
        assert_eq!(output.status.code(), Some(2));
        let error: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(error["code"], "unsupported_command");
    }
}

#[test]
fn copied_binary_cannot_select_a_different_checkout_root() {
    let fixture = Fixture::new();
    let output = Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate"))
        .args([
            "--candidate-root",
            fixture.0.to_str().unwrap(),
            "info",
            "--json",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["code"], "checkout_mismatch");
}

#[cfg(unix)]
#[test]
fn aliased_candidate_state_is_rejected_without_following_it() {
    let fixture = Fixture::new();
    let root = fixture.directory("candidate");
    let foreign = fixture.directory("foreign-state");
    std::os::unix::fs::symlink(&foreign, root.join(".hack-local")).unwrap();
    assert_eq!(
        Candidate::discover(&root).unwrap_err().code,
        "aliased_state"
    );
    std::fs::remove_file(root.join(".hack-local")).unwrap();
    let candidate = Candidate::discover(&root).unwrap();
    std::fs::create_dir_all(candidate.state_root.join("run")).unwrap();
    std::os::unix::fs::symlink(&foreign, candidate.state_root.join("run/workspaces")).unwrap();
    assert_eq!(
        candidate
            .plan(&fixture.directory("source"))
            .unwrap_err()
            .code,
        "aliased_state"
    );
    assert_eq!(std::fs::read_dir(foreign).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn invalid_utf8_input_has_a_typed_error_instead_of_panicking() {
    use std::os::unix::ffi::OsStringExt;
    let output = Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate"))
        .arg("--candidate-root")
        .arg(checkout())
        .args(["plan", "--project"])
        .arg(std::ffi::OsString::from_vec(vec![0xff]))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["code"], "unsupported_path");
}

#[cfg(unix)]
#[test]
fn unbuilt_launcher_never_invokes_hack_on_path() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let fake_checkout = fixture.directory("unbuilt-checkout");
    let launcher = fake_checkout.join("hack-local");
    std::fs::copy(checkout().join("hack-local"), &launcher).unwrap();
    let fake_bin = fixture.directory("bin");
    let fake_hack = fake_bin.join("hack");
    std::fs::write(
        &fake_hack,
        "#!/bin/sh\ntouch \"$HOME/global-hack-called\"\n",
    )
    .unwrap();
    std::fs::set_permissions(fake_hack, std::fs::Permissions::from_mode(0o755)).unwrap();
    let output = Command::new("/bin/sh")
        .arg(&launcher)
        .arg("up")
        .current_dir(&fixture.0)
        .env("HOME", &fixture.0)
        .env("PATH", format!("{}:/usr/bin:/bin", fake_bin.display()))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(69));
    assert!(!fixture.0.join("global-hack-called").exists());
}
