//! `graph clear-failure-after-started` accepts exactly `--run-id` (and `--json`),
//! refusing anything else before it opens a runtime.
use serde_json::Value;
use std::{fs, path::Path, process::Command};

#[test]
fn clear_failure_after_started_rejects_missing_duplicate_and_extra_flags_before_admission() {
    let root = std::env::temp_dir().join(format!(
        "failure-record-cli-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let run = "a".repeat(32);
    let upper = "A".repeat(32);
    let action = "clear-failure-after-started";
    let cases = [
        vec![action],
        vec![action, "--run-id"],
        vec![action, "--run-id", &run, "--run-id", &run],
        vec![action, "--run-id", &run, "--remove-data"],
        vec![action, "--run-id", &run, "--force"],
        vec![action, &run],
        vec![action, "--run-id", "not-a-run"],
        vec![action, "--run-id", &upper],
    ];
    for args in cases {
        let output = Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate"))
            .arg("--candidate-root")
            .arg(&checkout)
            .arg("graph")
            .args(&args)
            .arg("--json")
            .env_clear()
            .env("PATH", "/nonexistent")
            .env("HOME", root.join("home-not-created"))
            .output()
            .unwrap();
        assert!(!output.status.success(), "{args:?}");
        let value: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(value["code"], "graph_arguments", "{args:?}");
        assert!(
            fs::read_dir(&root).unwrap().next().is_none(),
            "argument refusal must have no runtime effects"
        );
    }
    fs::remove_dir(&root).unwrap();
}
