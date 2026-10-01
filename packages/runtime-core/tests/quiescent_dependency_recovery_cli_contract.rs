//! An explicit live recovery selection is required before provider access.
use serde_json::Value;
use std::{fs, path::Path, process::Command};

#[test]
fn quiescent_recovery_rejects_missing_duplicate_and_invalid_selection() {
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let home = std::env::temp_dir().join(format!("hack-quiescent-cli-{}", std::process::id()));
    fs::create_dir(&home).unwrap();
    let cases = [
        vec!["runtime", "recover-quiescent-dependency-sockets", "--json"],
        vec![
            "runtime",
            "recover-quiescent-dependency-sockets",
            "--expect-sha256",
            "invalid",
            "--json",
        ],
        vec![
            "runtime",
            "recover-quiescent-dependency-sockets",
            "--expect-sha256",
            "invalid",
            "--json",
            "--json",
        ],
        vec![
            "runtime",
            "quiescent-dependency-socket-recovery",
            "--json",
            "--json",
        ],
    ];
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
        assert!(
            matches!(
                failure["code"].as_str(),
                Some("unsupported_command" | "quiescent_dependency_socket_recovery")
            ),
            "{failure:?}"
        );
        assert_eq!(fs::read_dir(&home).unwrap().count(), 0);
    }
    fs::remove_dir(home).unwrap();
}
