//! Recovery acknowledgements must reject at the CLI boundary before any runtime admission.
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hack-absence-cli-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn absent_recovery_requires_one_exact_selection_and_both_acknowledgements() {
    let fixture = Fixture::new();
    // The development executable intentionally resolves its compiled checkout
    // before command dispatch. Supply that valid identity so these assertions
    // exercise recovery parsing instead of the unrelated checkout gate.
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let original = fixture.0.join("original-not-created.json");
    let inspection = fixture.0.join("inspection-not-created.json");
    let complete: Vec<String> = [
        "graph",
        "recover-absent-publication-cleanup",
        "--run-id",
        &"a".repeat(32),
        "--original-owner-file",
        original.to_str().unwrap(),
        "--host-inspection-file",
        inspection.to_str().unwrap(),
        "--expect-selection",
        &"b".repeat(64),
        "--retain-data",
        "--accept-unpinned-post-reboot",
        "--json",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    let mut cases = Vec::new();
    for flag in ["--retain-data", "--accept-unpinned-post-reboot"] {
        let mut missing = complete.clone();
        missing.retain(|argument| argument != flag);
        cases.push(missing);
        let mut duplicated = complete.clone();
        duplicated.push(flag.into());
        cases.push(duplicated);
    }
    for flag in [
        "--run-id",
        "--original-owner-file",
        "--host-inspection-file",
        "--expect-selection",
    ] {
        let mut missing = complete.clone();
        let position = missing
            .iter()
            .position(|argument| argument == flag)
            .unwrap();
        missing.drain(position..position + 2);
        cases.push(missing);
    }
    for extra in ["--remove-data", "--json", "--force"] {
        let mut invalid = complete.clone();
        invalid.push(extra.into());
        cases.push(invalid);
    }
    for arguments in cases {
        let output = Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate"))
            .arg("--candidate-root")
            .arg(&checkout)
            .args(&arguments)
            .env_clear()
            .env("PATH", "/nonexistent")
            .env("HOME", fixture.0.join("home-not-created"))
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{arguments:?}");
        assert!(
            output.stdout.is_empty(),
            "refusal must not emit a success result"
        );
        let failure: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(failure["code"], "graph_arguments", "{arguments:?}");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
    }
}
