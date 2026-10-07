use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

fn run(args: &[&str], input: &[u8]) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hack-config-compiler"))
        .args(args)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}
#[test]
fn handshake_and_compile_need_no_environment_or_host_tools() {
    let handshake = run(&["--protocol"], b"");
    assert!(handshake.status.success());
    let protocol: Value = serde_json::from_slice(&handshake.stdout).unwrap();
    assert_eq!(
        protocol,
        serde_json::json!({"transport_version":1,"authored_version":1,"plan_version":1,"resolve_version":1,"local_version":1})
    );
    let result = run(&["compile"], br#"{"schema_version":1,"name":"example"}"#);
    assert!(result.status.success());
    assert!(result.stderr.is_empty());
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["ok"], true);
    assert_eq!(value["plan"]["plan_version"], 1);
}
#[test]
fn invalid_input_has_a_redacted_json_failure_and_exit_one() {
    let result = run(
        &["compile"],
        br#"{"schema_version":1,"name":"private-sentinel",}"#,
    );
    assert_eq!(result.status.code(), Some(1));
    assert!(result.stderr.is_empty());
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["ok"], false);
    assert_eq!(value["diagnostics"][0]["code"], "invalid_json");
    assert!(
        !String::from_utf8(result.stdout)
            .unwrap()
            .contains("private-sentinel")
    );
}
#[test]
fn unknown_flags_refuse_without_echoing_arguments() {
    for args in [
        vec!["compile", "--profile"],
        vec!["resolve", "--profile"],
        vec!["resolve", "--unknown", "private-sentinel"],
        vec!["compile", "--unknown", "private-sentinel"],
        vec!["--protocol", "private-sentinel"],
    ] {
        let result = run(&args, b"");
        assert_eq!(result.status.code(), Some(2));
        assert!(result.stdout.is_empty());
        let stderr = String::from_utf8(result.stderr).unwrap();
        assert!(stderr.starts_with("Usage:"));
        assert!(!stderr.contains("private-sentinel"));
    }
}
#[test]
fn profile_selection_uses_explicit_repeatable_arguments() {
    let input=br#"{"schema_version":1,"name":"example","profiles":["dev","test"],"jobs":{"check":{"image":"check:1","profiles":["test"]}}}"#;
    let result = run(&["compile", "--profile", "test", "--profile", "dev"], input);
    assert!(result.status.success());
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(
        value["plan"]["selected_profiles"],
        serde_json::json!(["dev", "test"])
    );
    assert!(value["plan"]["jobs"]["check"].is_object());
}

#[test]
fn resolve_binary_preserves_profiles_and_reports_document_roles() {
    let project = r#"{"schema_version":1,"name":"example","profiles":["dev"],"jobs":{"init":{"image":"init:1","profiles":["dev"]}}}"#;
    let request = serde_json::json!({"request_version":1,"project":project,"checkout_local":r#"{"schema_version":1,"environment":{"default_overlay":null}}"#});
    let result = run(
        &["resolve", "--profile", "dev"],
        request.to_string().as_bytes(),
    );
    assert!(result.status.success());
    assert!(result.stderr.is_empty());
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(
        value["plan"]["selected_profiles"],
        serde_json::json!(["dev"])
    );
    assert_eq!(value["local_resolution"]["origin"], "checkout_local");
    assert!(value["local_resolution"]["overlay"].is_null());
    let mut request = request;
    request["checkout_local"] = serde_json::json!(r#"{"schema_version":1,"schema_version":1}"#);
    let result = run(&["resolve"], request.to_string().as_bytes());
    assert_eq!(result.status.code(), Some(1));
    assert!(result.stderr.is_empty());
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["diagnostics"][0]["code"], "duplicate_key");
    assert_eq!(value["diagnostics"][0]["document"], "checkout_local");
}
