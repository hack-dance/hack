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
    fn invoke_before_stdin(&self, args: &[&str]) -> Output {
        let mut child = self
            .command(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let unread = child.stdin.take().unwrap();
        let output = child.wait_with_output().unwrap();
        drop(unread);
        output
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
fn public_native_recovery_requires_exact_closed_selectors_and_refuses_absent_authority() {
    let fixture = Fixture::new();
    let run = "b".repeat(32);
    let receipt = "c".repeat(64);
    let owner = "d".repeat(64);
    let selected = [
        "graph",
        "native",
        "recover-live-owner",
        "--run-id",
        &run,
        "--expect-receipt",
        &receipt,
        "--expect-owner",
        &owner,
        "--json",
    ];
    let output = fixture.invoke(&selected);
    assert!(!output.status.success());
    #[cfg(target_os = "macos")]
    assert!(String::from_utf8_lossy(&output.stderr).contains("native_graph_live_owner_recovery"));
    #[cfg(not(target_os = "macos"))]
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("native_graph_foreground_unsupported")
    );
    fixture.assert_no_state();
    for extra in [
        vec!["--environment-stdin"],
        vec!["--json"],
        vec!["--run-id", &run],
        vec!["--source-file", fixture.source_path()],
        vec!["--expect-review", &receipt],
        vec!["--timeout-seconds", "1"],
        vec!["--action", "cleanup"],
    ] {
        let mut args = selected.to_vec();
        args.extend(extra);
        // A held empty pipe distinguishes argument refusal from private delivery.
        let output = fixture.invoke_before_stdin(&args);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("native_graph_arguments"));
        fixture.assert_no_state();
    }
    for bad in [
        vec!["graph", "native", "recover-live-owner", "--run-id", &run],
        vec![
            "graph",
            "native",
            "recover-live-owner",
            "--run-id",
            &run,
            "--expect-receipt",
            &receipt,
        ],
        vec![
            "graph",
            "native",
            "recover-live-owner",
            "--run-id",
            &run,
            "--expect-receipt",
            "private-recovery-cli-canary",
            "--expect-owner",
            &owner,
        ],
        vec![
            "graph",
            "native",
            "recover-live-owner",
            "--run-id",
            "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            "--expect-receipt",
            &receipt,
            "--expect-owner",
            &owner,
        ],
    ] {
        let output = fixture.invoke(&bad);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("native_graph_arguments"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("private-recovery-cli-canary"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("private-recovery-cli-canary"));
        fixture.assert_no_state();
    }
}

#[test]
fn recovery_hash_flags_never_widen_existing_native_actions() {
    let fixture = Fixture::new();
    let hash = "c".repeat(64);
    for action in ["plan", "run", "serve"] {
        for flag in ["--expect-receipt", "--expect-owner"] {
            let output = fixture.invoke(&[
                "graph",
                "native",
                action,
                "--source-file",
                fixture.source_path(),
                flag,
                &hash,
                "--json",
            ]);
            assert!(!output.status.success());
            assert!(String::from_utf8_lossy(&output.stderr).contains("native_graph_arguments"));
            fixture.assert_no_state();
        }
    }
    for action in ["inspect", "cleanup", "recovery-selection", "control"] {
        let mut args = vec![
            "graph",
            "native",
            action,
            "--run-id",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "--expect-owner",
            &hash,
            "--json",
        ];
        if action == "control" {
            args.extend(["--action", "status"]);
        }
        let output = fixture.invoke(&args);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("native_graph_arguments"));
        fixture.assert_no_state();
    }
}

#[test]
fn public_native_file_intent_refuses_before_private_stdin_or_candidate_state() {
    let fixture = Fixture::new();
    let project_path = fixture.project.join(".hack/hack.project.json");
    let baseline: Value = serde_json::from_slice(&fs::read(&project_path).unwrap()).unwrap();
    for (field, definition) in [
        ("configs", json!({})),
        ("secrets", json!({})),
        ("configs", json!({"unused":{"file":"authored-file-canary"}})),
        ("secrets", json!({"unused":{"env_ref":"TOKEN"}})),
    ] {
        let mut project = baseline.clone();
        project[field] = definition;
        fs::write(&project_path, project.to_string()).unwrap();
        let planned = fixture.invoke(&[
            "graph",
            "native",
            "plan",
            "--source-file",
            fixture.source_path(),
            "--json",
        ]);
        assert!(!planned.status.success());
        assert!(String::from_utf8_lossy(&planned.stderr).contains("native_graph_subset"));

        // Keep stdin open with no bytes. Source admission must refuse before the
        // bounded private receiver attempts to read it, even with a valid SHA shape.
        let expected = "c".repeat(64);
        let mut child = fixture
            .command(&[
                "graph",
                "native",
                "run",
                "--source-file",
                fixture.source_path(),
                "--expect-review",
                &expected,
                "--environment-stdin",
                "--json",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let unread_stdin = child.stdin.take().unwrap();
        let output = child.wait_with_output().unwrap();
        drop(unread_stdin);
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("native_graph_subset"), "{stderr}");
        assert!(!stderr.contains("authored-file-canary"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("authored-file-canary"));
        fixture.assert_no_state();
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

#[cfg(target_os = "macos")]
#[test]
fn public_native_serve_checks_review_and_private_codec_before_publication() {
    let fixture = Fixture::new();
    let wrong = "c".repeat(64);
    let legacy =
        json!({"version":1,"kind":"compose-graph-environment","values":"private-serve-canary"});
    let output = fixture.invoke_private(
        &[
            "graph",
            "native",
            "serve",
            "--source-file",
            fixture.source_path(),
            "--expect-review",
            &wrong,
            "--environment-stdin",
            "--json",
        ],
        &legacy,
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("native_graph_review_changed"));
    fixture.assert_no_state();
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
    let output = fixture.invoke_private(
        &[
            "graph",
            "native",
            "serve",
            "--source-file",
            fixture.source_path(),
            "--expect-review",
            review["review_id"].as_str().unwrap(),
            "--environment-stdin",
            "--json",
        ],
        &legacy,
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("graph_environment_input"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("private-serve-canary"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("private-serve-canary"));
    fixture.assert_no_state();
}

#[test]
fn public_native_control_requires_exact_action_and_never_adopts_absent_owner() {
    let fixture = Fixture::new();
    let run = "b".repeat(32);
    for action in ["status", "cleanup"] {
        let output = fixture.invoke(&[
            "graph", "native", "control", "--run-id", &run, "--action", action, "--json",
        ]);
        assert!(!output.status.success());
        #[cfg(target_os = "macos")]
        assert!(String::from_utf8_lossy(&output.stderr).contains("native_graph_foreground"));
        #[cfg(not(target_os = "macos"))]
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("native_graph_foreground_unsupported")
        );
        fixture.assert_no_state();
    }
    for args in [
        vec!["graph", "native", "control", "--run-id", &run],
        vec![
            "graph", "native", "control", "--run-id", &run, "--action", "restart",
        ],
        vec![
            "graph", "native", "control", "--run-id", &run, "--action", "status", "--action",
            "cleanup",
        ],
        vec![
            "graph",
            "native",
            "control",
            "--run-id",
            &run,
            "--action",
            "cleanup",
            "--environment-stdin",
        ],
        vec![
            "graph",
            "native",
            "control",
            "--run-id",
            &run,
            "--action",
            "status",
            "--source-file",
            fixture.source_path(),
        ],
        vec![
            "graph",
            "native",
            "serve",
            "--source-file",
            fixture.source_path(),
            "--run-id",
            &run,
        ],
        vec![
            "graph",
            "native",
            "run",
            "--source-file",
            fixture.source_path(),
            "--action",
            "status",
        ],
    ] {
        let output = fixture.invoke(&args);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("native_graph_arguments"));
        fixture.assert_no_state();
    }
}

#[test]
fn public_native_recovery_selection_is_closed_read_only_and_never_creates_missing_authority() {
    let fixture = Fixture::new();
    let run = "b".repeat(32);
    let output = fixture.invoke(&[
        "graph",
        "native",
        "recovery-selection",
        "--run-id",
        &run,
        "--json",
    ]);
    assert!(!output.status.success());
    #[cfg(target_os = "macos")]
    assert!(String::from_utf8_lossy(&output.stderr).contains("native_graph_live_owner_recovery"));
    #[cfg(not(target_os = "macos"))]
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("native_graph_foreground_unsupported")
    );
    fixture.assert_no_state();
    for extra in [
        vec!["--environment-stdin"],
        vec!["--source-file", fixture.source_path()],
        vec!["--action", "cleanup"],
        vec!["--expect-review", "private-selection-canary"],
        vec!["--timeout-seconds", "1"],
        vec!["--run-id", &run],
    ] {
        let mut args = vec![
            "graph",
            "native",
            "recovery-selection",
            "--run-id",
            &run,
            "--json",
        ];
        args.extend(extra);
        let output = fixture.invoke(&args);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("native_graph_arguments"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("private-selection-canary"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("private-selection-canary"));
        fixture.assert_no_state();
    }
}

#[cfg(not(target_os = "macos"))]
#[test]
fn public_native_serve_refuses_platform_before_private_descriptor_or_source_read() {
    let fixture = Fixture::new();
    let wrong = "c".repeat(64);
    let output = fixture.invoke(&[
        "graph",
        "native",
        "serve",
        "--source-file",
        "/missing/native-source.json",
        "--expect-review",
        &wrong,
        "--environment-stdin",
        "--json",
    ]);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("native_graph_foreground_unsupported")
    );
    fixture.assert_no_state();
}
