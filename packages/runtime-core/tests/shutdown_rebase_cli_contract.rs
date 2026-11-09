//! Repair must require an exact explicit selection before opening a runtime.
use serde_json::Value;
use std::{fs, path::Path, process::Command};

#[test]
fn shutdown_rebase_rejects_missing_duplicate_and_destructive_flags_before_admission() {
    let root = std::env::temp_dir().join(format!(
        "shutdown-rebase-cli-{}-{}",
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
    let selection = "b".repeat(64);
    let cases = [
        vec!["recover-shutdown-rebase", "--run-id", &run],
        vec!["recover-shutdown-rebase", "--expect-selection", &selection],
        vec![
            "recover-shutdown-rebase",
            "--run-id",
            &run,
            "--expect-selection",
            &selection,
            "--force",
        ],
        vec![
            "recover-shutdown-rebase",
            "--run-id",
            &run,
            "--expect-selection",
            &selection,
            "--remove-data",
        ],
        vec![
            "recover-shutdown-rebase",
            "--run-id",
            &run,
            "--expect-selection",
            &selection,
            "--expect-selection",
            &selection,
        ],
        vec!["inspect-shutdown-rebase", "--run-id", &run, "--remove-data"],
    ];
    for args in cases {
        let output = Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate"))
            .arg("--candidate-root")
            .arg(&checkout)
            .arg("graph")
            .args(args)
            .arg("--json")
            .env_clear()
            .env("PATH", "/nonexistent")
            .env("HOME", root.join("home-not-created"))
            .output()
            .unwrap();
        assert!(!output.status.success());
        let value: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(value["code"], "graph_arguments");
        assert!(
            fs::read_dir(&root).unwrap().next().is_none(),
            "argument refusal must have no runtime effects"
        );
    }
    fs::remove_dir(&root).unwrap();
}
