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
        serde_json::json!({"transport_version":1,"authored_version":1,"plan_version":1,"resolve_version":1,"local_version":1,"env_plan_version":1,"host_env_plan_version":1,"routing_plan_version":1,"endpoint_plan_version":1,"process_plan_version":1})
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

#[test]
fn environment_plan_process_separates_valid_documents_from_complete_bindings() {
    let project = r#"{"schema_version":1,"name":"example","jobs":{"init":{"image":"init:1","environment":{"NEEDED":{"env_ref":"KEY"}}}}}"#;
    let mut request = serde_json::json!({"request_version":1,"project":project,"env_metadata":{"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{"init":{}},"inactive_scopes":[]}});
    let output = run(&["plan"], request.to_string().as_bytes());
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stderr.is_empty());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(result["environment_plan"]["complete"], false);
    request["env_metadata"]["workloads"]["init"]["KEY"] =
        serde_json::json!({"scope":"init","secret":true});
    let output = run(&["plan"], request.to_string().as_bytes());
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["environment_plan"]["complete"], true);
    let output = run(&["plan", "--unsupported", "private-sentinel"], b"");
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(
        !String::from_utf8(output.stderr)
            .unwrap()
            .contains("private-sentinel")
    );
}

#[test]
fn host_planning_does_not_execute_authored_commands() {
    let project = r#"{"schema_version":1,"name":"example","host":{"up":{"before":[{"name":"before","command":{"shell":"exit 93"}}]},"processes":{"watch":{"command":{"shell":"exit 94"},"singleton":{"ports":[1],"on_conflict":"adopt"}}}}}"#;
    let request = serde_json::json!({"request_version":1,"project":project,"env_metadata":{"metadata_version":1,"overlay":null,"overlay_exists":false,"workloads":{},"inactive_scopes":[],"host":{"default":{},"workloads":{}}}});
    let output = run(&["plan"], request.to_string().as_bytes());
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["environment_plan"]["complete"], true);
    assert_eq!(
        result["host_env_targets"],
        serde_json::json!({"include_default":true,"workloads":[]})
    );
    assert_eq!(
        result["environment_plan"]["host"]
            .as_object()
            .unwrap()
            .len(),
        2
    );
}
