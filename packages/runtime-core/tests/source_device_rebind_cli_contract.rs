//! The explicit continuity acknowledgement must be exact before provider access.
use serde_json::Value;
use std::{fs, path::Path, process::Command};

#[test]
fn source_device_rebind_requires_exact_selection_and_acknowledgement() {
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let home = std::env::temp_dir().join(format!(
        "hack-source-rebind-cli-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&home).unwrap();
    let full = [
        "graph".to_owned(),
        "recover-source-device-rebind".to_owned(),
        "--run-id".to_owned(),
        "a".repeat(32),
        "--expect-selection".to_owned(),
        "b".repeat(64),
        "--accept-legacy-device-rebind".to_owned(),
        "--json".to_owned(),
    ];
    let mut cases = Vec::new();
    for flag in ["--accept-legacy-device-rebind", "--json"] {
        let mut duplicate = full.to_vec();
        duplicate.push(flag.to_owned());
        cases.push(duplicate);
    }
    for flag in ["--run-id", "--expect-selection"] {
        let mut missing = full.to_vec();
        let index = missing.iter().position(|value| value == flag).unwrap();
        missing.drain(index..index + 2);
        cases.push(missing);
    }
    let mut unacknowledged = full.to_vec();
    unacknowledged.retain(|value| value != "--accept-legacy-device-rebind");
    cases.push(unacknowledged);
    for arguments in cases {
        let output = Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate"))
            .arg("--candidate-root")
            .arg(&checkout)
            .args(&arguments)
            .env_clear()
            .env("PATH", "/nonexistent")
            .env("HOME", &home)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{arguments:?}");
        assert!(output.stdout.is_empty());
        let failure: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(failure["code"], "graph_arguments", "{arguments:?}");
        assert_eq!(fs::read_dir(&home).unwrap().count(), 0);
    }
    fs::remove_dir(&home).unwrap();
}
