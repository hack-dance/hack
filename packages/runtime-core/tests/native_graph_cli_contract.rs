#![cfg(all(feature = "native-config-plan", feature = "installed-candidate"))]
//! Real public CLI admission/refusal controls; no guest is initialized or touched.
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::DirBuilderExt,
    path::PathBuf,
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
struct Fixture {
    root: PathBuf,
    home: PathBuf,
    source: PathBuf,
    project: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "native-graph-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let home = root.join("home");
        let project = root.join("project");
        for path in [&home, &project, &project.join(".hack")] {
            fs::DirBuilder::new().mode(0o700).create(path).unwrap();
        }
        fs::write(project.join(".hack/hack.project.json"),json!({"schema_version":1,"name":"fixture","services":{"web":{"image":format!("sha256:{}","d".repeat(64)),"command":{"exec":["/bin/echo","$EXACT"]}}}}).to_string()).unwrap();
        let source = root.join("source.json");
        let fixture = Self {
            root,
            home,
            source,
            project,
        };
        fixture.write_source(fixture.source_value());
        fixture
    }
    fn source_value(&self) -> Value {
        json!({"version":2,"kind":"native-graph-source","project":self.project,"branch":"fixture","run":"b".repeat(32),"profiles":[],"overlay":"inherit","env_metadata":{"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"web":{}},"inactive_scopes":[]}})
    }
    fn write_source(&self, value: Value) {
        fs::write(&self.source, value.to_string()).unwrap();
    }
    fn invoke(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hack-native"));
        command
            .arg("--candidate-root")
            .arg(&self.home)
            .args(args)
            .env_clear()
            .env("PATH", "/nonexistent");
        command
    }
    fn invoke_private(&self, args: &[&str], input: &Value) -> Output {
        let mut child = self
            .command(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.to_string().as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }
    fn source_path(&self) -> &str {
        self.source.to_str().unwrap()
    }
    fn assert_no_state(&self) {
        assert!(!self.home.join(".hack-local").exists());
    }
}

#[test]
fn public_native_private_pipe_refuses_legacy_and_changed_bindings_before_guest_admission() {
    let fixture = Fixture::new();
    let planned = fixture.invoke(&[
        "graph",
        "native",
        "plan",
        "--source-file",
        fixture.source_path(),
        "--json",
    ]);
    assert!(planned.status.success());
    let review: Value = serde_json::from_slice(&planned.stdout).unwrap();
    let expected = review["review_id"].as_str().unwrap();
    let valid = json!({"version":2,"kind":"native-graph-environment","review":expected,"run":"b".repeat(32),"lifetime_seconds":30,"services":{"web":{"KEY":"private-pipe-canary"}}});
    for (key, value) in [
        ("version", json!(1)),
        ("kind", json!("compose-graph-environment")),
        ("run", json!("a".repeat(32))),
        ("plan", json!(expected)),
    ] {
        let mut bad = valid.clone();
        bad[key] = value;
        let output = fixture.invoke_private(
            &[
                "graph",
                "native",
                "run",
                "--source-file",
                fixture.source_path(),
                "--expect-review",
                expected,
                "--environment-stdin",
                "--json",
            ],
            &bad,
        );
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("graph_environment_input"), "{stderr}");
        assert!(!stderr.contains("private-pipe-canary"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("private-pipe-canary"));
        fixture.assert_no_state();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn public_native_plan_binds_real_namespace_and_run_without_compose_or_runtime_state() {
    let fixture = Fixture::new();
    let output = fixture.invoke(&[
        "graph",
        "native",
        "plan",
        "--source-file",
        fixture.source_path(),
        "--json",
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let review: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(review["review_id"].as_str().unwrap().len(), 64);
    assert_eq!(review["provenance"]["run"], "b".repeat(32));
    let candidate = hack_runtime_core::Candidate::discover(&fixture.home).unwrap();
    assert_eq!(
        review["provenance"]["namespace"],
        candidate
            .plan_with_branch(&fixture.project, Some("fixture"))
            .unwrap()
            .namespace
    );
    assert!(review.get("plan_id").is_none());
    assert!(review.get("normalized_input").is_none());
    fixture.assert_no_state();
}

#[test]
fn public_native_run_refuses_wrong_review_and_compose_flags_before_guest_admission() {
    let fixture = Fixture::new();
    let wrong = "c".repeat(64);
    let output = fixture.invoke(&[
        "graph",
        "native",
        "run",
        "--source-file",
        fixture.source_path(),
        "--expect-review",
        &wrong,
        "--json",
    ]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("native_graph_review_changed"));
    fixture.assert_no_state();
    for args in [
        vec![
            "graph",
            "native",
            "plan",
            "--source-file",
            fixture.source_path(),
            "--expect-original",
            &wrong,
        ],
        vec!["graph", "run", "--source-file", fixture.source_path()],
        vec![
            "graph",
            "native",
            "plan",
            "--source-file",
            fixture.source_path(),
            "--environment-stdin",
        ],
    ] {
        assert!(!fixture.invoke(&args).status.success());
        fixture.assert_no_state();
    }
}

#[test]
fn public_native_source_rejects_legacy_and_unknown_private_fields_without_reflection() {
    let fixture = Fixture::new();
    for (key, value) in [
        ("version", json!(1)),
        ("kind", json!("normalized-compose")),
        ("values", json!("private-cli-canary")),
    ] {
        let mut bad = fixture.source_value();
        bad[key] = value;
        fixture.write_source(bad);
        let output = fixture.invoke(&[
            "graph",
            "native",
            "plan",
            "--source-file",
            fixture.source_path(),
            "--json",
        ]);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("native_graph_selection"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("private-cli-canary"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("private-cli-canary"));
        fixture.assert_no_state();
    }
}
