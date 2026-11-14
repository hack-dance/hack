use hack_runtime_core::Candidate;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
const ORIGINAL: &str = "services:\n  web:\n    image: alpine:3.20\n    volumes: [./src:/app]\n";
struct Fixture {
    root: PathBuf,
    project: PathBuf,
    normalized: PathBuf,
    namespace: String,
    hash: String,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hack-normalized-command-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let project = root.join("project");
        fs::create_dir_all(project.join("src")).unwrap();
        fs::write(project.join("src/app.txt"), "public source").unwrap();
        fs::write(project.join("compose.yml"), ORIGINAL).unwrap();
        let normalized = root.join("public-normalized.yml");
        fs::write(&normalized, ORIGINAL.replace("alpine:3.20", "alpine:3.21")).unwrap();
        let namespace = Candidate::discover(&checkout())
            .unwrap()
            .plan(&project)
            .unwrap()
            .namespace;
        Self {
            root,
            project,
            normalized,
            namespace,
            hash: format!("{:x}", Sha256::digest(ORIGINAL.as_bytes())),
        }
    }
    fn invoke(&self, prefix: &[&str], suffix: &[&str]) -> Output {
        self.invoke_with_namespace(prefix, suffix, &self.namespace)
    }
    fn invoke_with_namespace(&self, prefix: &[&str], suffix: &[&str], namespace: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate"))
            .arg("--candidate-root")
            .arg(checkout())
            .args(prefix)
            .arg("--project")
            .arg(&self.project)
            .args(["--file", "compose.yml"])
            .arg("--normalized-file")
            .arg(&self.normalized)
            .args([
                "--expect-original",
                &self.hash,
                "--expect-namespace",
                namespace,
            ])
            .args(suffix)
            .current_dir(&self.root)
            .env_clear()
            .env("PATH", "/nonexistent")
            .env("HACK_HOME", self.root.join("unused"))
            .env("DOCKER_HOST", "unix:///must-not-connect")
            .output()
            .unwrap()
    }
}
#[test]
fn branch_selector_is_required_at_each_normalized_review_and_capture() {
    let fixture = Fixture::new();
    let candidate = Candidate::discover(&checkout()).unwrap();
    let alpha = candidate
        .plan_with_branch(&fixture.project, Some("alpha"))
        .unwrap()
        .namespace;
    let base = fixture.invoke(&["project", "plan"], &["--json"]);
    assert!(base.status.success(), "{base:?}");
    let base: Value = serde_json::from_slice(&base.stdout).unwrap();
    let branch = fixture.invoke_with_namespace(
        &["project", "plan"],
        &["--branch", "alpha", "--json"],
        &alpha,
    );
    assert!(branch.status.success(), "{branch:?}");
    let branch: Value = serde_json::from_slice(&branch.stdout).unwrap();
    assert_eq!(branch["plan"]["namespace"], alpha);
    assert_eq!(branch["plan"]["branch"], "alpha");
    assert_ne!(branch["plan_id"], base["plan_id"]);
    let branch_id = branch["plan_id"].as_str().unwrap();
    let capture = fixture.invoke_with_namespace(
        &["project", "capture"],
        &["--branch", "alpha", "--expect-plan", branch_id, "--json"],
        &alpha,
    );
    assert!(capture.status.success(), "{capture:?}");
    assert_eq!(
        error(fixture.invoke_with_namespace(&["project", "plan"], &["--json"], &alpha)),
        "normalized_compose_input"
    );
    assert_eq!(
        error(fixture.invoke_with_namespace(
            &["project", "plan"],
            &["--branch", "beta", "--json"],
            &alpha
        )),
        "normalized_compose_input"
    );
    assert_eq!(
        error(fixture.invoke_with_namespace(
            &["graph", "run"],
            &[
                "--branch",
                "alpha",
                "--run-id",
                &"a".repeat(32),
                "--expect-plan",
                base["plan_id"].as_str().unwrap(),
                "--ready",
                "web=started"
            ],
            &alpha
        )),
        "stale_plan"
    );
    assert_eq!(
        error(fixture.invoke_with_namespace(
            &["graph", "source-compatibility"],
            &[
                "--branch",
                "alpha",
                "--run-id",
                &"a".repeat(32),
                "--expect-plan",
                base["plan_id"].as_str().unwrap(),
            ],
            &alpha
        )),
        "stale_plan"
    );
    assert_eq!(
        error(fixture.invoke_with_namespace(&["project", "plan"], &["--branch", "Alpha"], &alpha)),
        "invalid_branch"
    );
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn checkout() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}
fn error(output: Output) -> String {
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(output.stdout.is_empty());
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    error["code"].as_str().unwrap().to_owned()
}
#[test]
fn normalized_plan_and_capture_share_review_and_preserve_original() {
    let fixture = Fixture::new();
    let output = fixture.invoke(&["project", "plan"], &["--json"]);
    assert!(output.status.success(), "{output:?}");
    let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
    let plan_id = plan["plan_id"].as_str().unwrap();
    let capture = fixture.invoke(
        &["project", "capture"],
        &["--expect-plan", plan_id, "--json"],
    );
    assert!(capture.status.success(), "{capture:?}");
    assert_eq!(
        fs::read_to_string(fixture.project.join("compose.yml")).unwrap(),
        ORIGINAL
    );
    assert!(!fixture.root.join("unused").exists());
    assert_eq!(
        error(fixture.invoke(&["project", "capture"], &["--expect-plan", &"0".repeat(64)])),
        "stale_plan"
    );
}
#[test]
fn changed_original_refuses_review_capture_publication_and_graph_before_runtime() {
    let fixture = Fixture::new();
    fs::write(fixture.project.join("compose.yml"), "services: {}\n").unwrap();
    for action in ["plan", "capture", "publish-source", "verify-source"] {
        assert_eq!(
            error(fixture.invoke(&["project", action], &[])),
            "normalized_compose_input"
        );
    }
    for action in ["run", "serve"] {
        assert_eq!(
            error(fixture.invoke(
                &["graph", action],
                &[
                    "--run-id",
                    &"a".repeat(32),
                    "--expect-plan",
                    &"b".repeat(64),
                    "--ready",
                    "web=started"
                ]
            )),
            "normalized_compose_input"
        );
    }
}
#[test]
fn unsupported_normalized_operations_refuse_instead_of_file_fallback() {
    let fixture = Fixture::new();
    for action in ["enroll", "sync-source", "sync-status", "status"] {
        assert_eq!(
            error(fixture.invoke(&["project", action], &[])),
            "normalized_cli_input"
        );
    }
    for action in ["restart", "restore", "owner-restore"] {
        assert_eq!(
            error(fixture.invoke(&["graph", action], &[])),
            "normalized_cli_input"
        );
    }
    assert_eq!(
        error(fixture.invoke(&["graph", "run"], &["--live-source"])),
        "normalized_live_source_unsupported"
    );
}

#[test]
fn normalized_capture_keeps_removed_original_credential_files_excluded() {
    let mut fixture = Fixture::new();
    fs::create_dir(fixture.project.join("config")).unwrap();
    fs::write(
        fixture.project.join("config/private-vars.txt"),
        "TOKEN=PRIVATE_CLI_CANARY\n",
    )
    .unwrap();
    let original = ORIGINAL.replace(
        "    image:",
        "    env_file: [./config/private-vars.txt]\n    image:",
    );
    fs::write(fixture.project.join("compose.yml"), &original).unwrap();
    fixture.hash = format!("{:x}", Sha256::digest(original.as_bytes()));
    let plan = fixture.invoke(&["project", "plan"], &["--json"]);
    assert!(plan.status.success(), "{plan:?}");
    let plan: Value = serde_json::from_slice(&plan.stdout).unwrap();
    assert!(
        plan["plan"]["source_selection"]["excluded_paths"]
            .as_array()
            .unwrap()
            .iter()
            .any(|path| path == "config/private-vars.txt")
    );
    let capture = fixture.invoke(
        &["project", "capture"],
        &["--expect-plan", plan["plan_id"].as_str().unwrap(), "--json"],
    );
    assert!(capture.status.success(), "{capture:?}");
    let receipt: Value = serde_json::from_slice(&capture.stdout).unwrap();
    assert!(
        receipt["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["path"] != "config/private-vars.txt")
    );
    assert!(
        !String::from_utf8(capture.stdout)
            .unwrap()
            .contains("PRIVATE_CLI_CANARY")
    );
}

#[test]
fn optional_raw_and_repeated_env_files_keep_future_secret_paths_excluded() {
    let mut fixture = Fixture::new();
    let original = ORIGINAL.replace("    image:", "    env_file:\n      - {path: future/private.txt, required: false, format: raw}\n      - {path: future/private.txt, required: false}\n    image:");
    fs::write(fixture.project.join("compose.yml"), &original).unwrap();
    fixture.hash = format!("{:x}", Sha256::digest(original.as_bytes()));
    for exists in [false, true] {
        if exists {
            fs::create_dir(fixture.project.join("future")).unwrap();
            fs::write(
                fixture.project.join("future/private.txt"),
                "TOKEN=OPTIONAL_INPUT_CANARY",
            )
            .unwrap();
            fs::write(fixture.project.join(".env"), "TOKEN=DOTENV_INPUT_CANARY").unwrap();
        }
        let output = fixture.invoke(&["project", "plan"], &["--json"]);
        assert!(output.status.success(), "{output:?}");
        let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            plan["plan"]["original_environment_files"],
            serde_json::json!(["future/private.txt"])
        );
        let output = fixture.invoke(
            &["project", "capture"],
            &["--expect-plan", plan["plan_id"].as_str().unwrap(), "--json"],
        );
        assert!(output.status.success(), "{output:?}");
        let capture: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            capture["entries"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry["path"] != "future/private.txt" && entry["path"] != ".env")
        );
        assert!(
            !String::from_utf8(output.stdout)
                .unwrap()
                .contains("INPUT_CANARY")
        );
    }
}

#[test]
fn environment_file_ignore_rule_aliases_refuse_without_reading_values() {
    let mut fixture = Fixture::new();
    fs::write(
        fixture.project.join(".ignore"),
        "IGNORE_RULE_PRIVATE_CANARY",
    )
    .unwrap();
    for path in [".IGNORE", ".GitIgnore"] {
        let original = ORIGINAL.replace(
            "    image:",
            &format!("    env_file: [{{path: {path}, required: false}}]\n    image:"),
        );
        fs::write(fixture.project.join("compose.yml"), &original).unwrap();
        fixture.hash = format!("{:x}", Sha256::digest(original.as_bytes()));
        let output = fixture.invoke(&["project", "plan"], &["--json"]);
        assert!(!String::from_utf8_lossy(&output.stdout).contains("PRIVATE_CANARY"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("PRIVATE_CANARY"));
        assert_eq!(error(output), "conflicting_environment_owner");
    }
}

#[test]
fn removed_inactive_required_env_file_retains_ownership_while_absent() {
    let mut fixture = Fixture::new();
    fs::create_dir(fixture.project.join("future")).unwrap();
    let original = format!(
        "{ORIGINAL}  inactive:\n    image: alpine:3.20\n    profiles: [extra]\n    env_file: future/inactive.txt\n"
    );
    fs::write(fixture.project.join("compose.yml"), &original).unwrap();
    fs::write(
        &fixture.normalized,
        original.replace("    env_file: future/inactive.txt\n", ""),
    )
    .unwrap();
    fixture.hash = format!("{:x}", Sha256::digest(original.as_bytes()));
    let output = fixture.invoke(&["project", "plan"], &["--json"]);
    assert!(output.status.success(), "{output:?}");
    let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        plan["plan"]["original_environment_files"],
        serde_json::json!(["future/inactive.txt"])
    );
    assert_eq!(plan["plan"]["services"]["inactive"]["active"], false);
    fs::write(
        fixture.project.join("future/inactive.txt"),
        "TOKEN=INACTIVE_FILE_CANARY",
    )
    .unwrap();
    // File presence changes source metadata; an old review still must refuse.
    assert_eq!(
        error(fixture.invoke(
            &["project", "capture"],
            &["--expect-plan", plan["plan_id"].as_str().unwrap(), "--json"]
        )),
        "stale_plan"
    );
    let current = fixture.invoke(&["project", "plan"], &["--json"]);
    assert!(current.status.success(), "{current:?}");
    let current: Value = serde_json::from_slice(&current.stdout).unwrap();
    assert_eq!(
        current["plan"]["original_environment_files"],
        plan["plan"]["original_environment_files"]
    );
    let output = fixture.invoke(
        &["project", "capture"],
        &[
            "--expect-plan",
            current["plan_id"].as_str().unwrap(),
            "--json",
        ],
    );
    assert!(output.status.success(), "{output:?}");
    let capture: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        !capture["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == "future/inactive.txt")
    );
    assert!(
        !String::from_utf8(output.stdout)
            .unwrap()
            .contains("INACTIVE_FILE_CANARY")
    );
}
