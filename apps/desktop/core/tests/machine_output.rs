//! The same fixtures are checked against the CLI producers by Bun tests.
use hack_desktop_core::runner::{RunError, parse_schema_result};
use serde_json::Value;

#[test]
fn migrated_payloads_require_the_expected_envelope_and_schema() {
    let cases = [
        (
            include_str!("fixtures/machine-output/activity.json"),
            "hack.activity.v1",
        ),
        (
            include_str!("fixtures/machine-output/version.json"),
            "hack.version.v1",
        ),
        (
            include_str!("fixtures/machine-output/files-cat.json"),
            "hack.files.v1",
        ),
        (
            include_str!("fixtures/machine-output/projects-observe.json"),
            "hack.projects.observe.v1",
        ),
        (
            include_str!("fixtures/machine-output/global-status-observe.json"),
            "hack.global-status.observe.v1",
        ),
        (
            include_str!("fixtures/machine-output/global-install-plan.json"),
            "hack.global-admin-plan.v1",
        ),
        (
            include_str!("fixtures/machine-output/global-trust-plan.json"),
            "hack.global-admin-plan.v1",
        ),
    ];
    for (text, schema) in cases {
        let value = parse_schema_result(text, "", Some(0), schema).unwrap();
        assert_eq!(value["schema"], schema);
        // Bare payloads, wrong schemas and success with a failing process are refused.
        assert!(parse_schema_result(&value.to_string(), "", Some(0), schema).is_err());
        assert!(parse_schema_result(text, "", Some(0), "unknown.schema").is_err());
        assert!(parse_schema_result(text, "", Some(1), schema).is_err());
    }
}

#[test]
fn files_preview_preserves_text_and_the_worktree_mapping() {
    use hack_desktop_core::files::{Encoding, FileSource, Report};
    let value = parse_schema_result(
        include_str!("fixtures/machine-output/files-cat.json"),
        "",
        Some(0),
        "hack.files.v1",
    )
    .unwrap();
    let Report::Cat {
        entry,
        encoding,
        content,
        truncated,
    } = serde_json::from_value(value).unwrap()
    else {
        panic!("expected a preview");
    };
    assert!(entry.source == FileSource::Worktree && encoding == Encoding::Utf8);
    assert_eq!(entry.path, "/app/example.txt");
    assert_eq!(
        entry.host_path.as_deref(),
        Some(std::path::Path::new("/example/checkout/example.txt"))
    );
    assert_eq!(content, "example\n");
    assert!(!truncated);

    // A service recreated with a different bind must not open the old path.
    let mut current = entry.clone();
    current.host_path = Some("/example/checkout/other/example.txt".into());
    assert_eq!(
        entry.editor_path(&current, std::path::Path::new("/example/checkout")),
        Err("The service's worktree mount changed. Refresh Files and try again.")
    );
}

#[test]
fn incomplete_admin_plan_is_an_error_with_preserved_recovery_evidence() {
    let text = include_str!("fixtures/machine-output/plan-incomplete.json");
    let error = parse_schema_result(text, "", Some(3), "hack.global-admin-plan.v1").unwrap_err();
    match error {
        RunError::Cli(error) => {
            assert_eq!(error.code, "E_PLAN_INCOMPLETE");
            assert_eq!(
                error.detail.unwrap()["plan"]["schema"],
                "hack.global-admin-plan.v1"
            );
        }
        other => panic!("unexpected result: {other:?}"),
    }
    assert!(parse_schema_result(text, "", Some(0), "hack.global-admin-plan.v1").is_err());
}

#[test]
fn malformed_envelopes_cannot_fall_back_to_legacy_parsing() {
    for value in [
        serde_json::json!({"ok": true, "data": {}}),
        serde_json::json!({"ok": false, "error": "legacy message"}),
        serde_json::json!({"ok": false, "error": {"code": "BAD", "message": "message"}}),
        serde_json::json!({"ok": false, "error": {"code": "E_", "message": "message"}}),
        serde_json::json!({"ok": true, "data": {"schema": "hack.version.v1"}, "extra": true}),
        Value::Null,
    ] {
        assert!(parse_schema_result(&value.to_string(), "", Some(1), "hack.version.v1").is_err());
    }
}

#[test]
fn version_envelope_accepts_additive_metadata() {
    let text = r#"{"ok":true,"data":{"schema":"hack.version.v1","version":"5.0.0"},"meta":{"producer":"hack"}}"#;
    let data = parse_schema_result(text, "", Some(0), "hack.version.v1").unwrap();
    assert_eq!(data["version"], "5.0.0");
    assert!(parse_schema_result(text, "", Some(1), "hack.version.v1").is_err());
    let conflict =
        r#"{"ok":true,"data":{"schema":"hack.version.v1","version":"5.0.0"},"error":{}}"#;
    assert!(parse_schema_result(conflict, "", Some(0), "hack.version.v1").is_err());
}
