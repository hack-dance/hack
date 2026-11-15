//! Negative evidence and fixed-action contracts. No real CLI or services.
use hack_desktop_core::{
    doctor::DoctorRun,
    models::{DoctorCheck, DoctorReport, ProjectsPayload},
    setup::{self, Platform, Remedy, SafeAction, Status},
};
fn machine(ids: &[(&str, &str)]) -> DoctorRun {
    DoctorRun::machine(Ok(DoctorReport {
        checks: ids
            .iter()
            .map(|(id, status)| DoctorCheck {
                id: (*id).into(),
                status: (*status).into(),
                detail: String::new(),
            })
            .collect(),
        ..Default::default()
    }))
}
fn derive(
    runs: &[DoctorRun],
    platform: Platform,
    daemon: serde_json::Value,
    socket: Option<&str>,
) -> setup::Report {
    setup::derive(
        Ok("5.0.0"),
        Some(&ProjectsPayload {
            runtime_ok: Some(true),
            ..Default::default()
        }),
        socket,
        Some(&daemon),
        runs,
        platform,
    )
}
#[test]
fn export_is_not_trust_and_absence_not_pass() {
    let r = derive(
        &[machine(&[("caddy local ca", "ok")])],
        Platform::Linux,
        serde_json::json!({}),
        None,
    );
    assert_eq!(
        r.cards.iter().find(|c| c.id == "trust").unwrap().status,
        Status::Unknown
    );
    assert!(r.needed());
    assert_eq!(
        r.cards.iter().find(|c| c.id == "login").unwrap().status,
        Status::Unknown
    );
}
#[test]
fn all_mac_dns_checks_required_including_custom_pairs() {
    let ids = [
        ("resolver:hack", "ok"),
        ("resolver:hack.local", "ok"),
        ("resolver:hack.gy", "ok"),
        ("dnsmasq.conf:hack", "ok"),
        ("dnsmasq.conf:hack.local", "ok"),
        ("dnsmasq.conf:hack.gy", "ok"),
        ("dnsmasq:53", "ok"),
        ("coredns forwarding", "ok"),
    ];
    let state = |pairs: &[(&str, &str)]| {
        derive(
            &[machine(pairs)],
            Platform::Mac,
            serde_json::json!({}),
            None,
        )
        .cards
        .into_iter()
        .find(|c| c.id == "routing")
        .unwrap()
        .status
    };
    assert_eq!(state(&ids), Status::Passed);
    for i in 0..ids.len() {
        let mut missing = ids.to_vec();
        missing.remove(i);
        assert_eq!(state(&missing), Status::Unknown, "missing {}", ids[i].0);
    }
    for status in ["skipped", "unexpected", ""] {
        let mut unknown = ids;
        unknown[0].1 = status;
        assert_eq!(state(&unknown), Status::Unknown);
    }
    let mut custom = ids.to_vec();
    custom.push(("resolver:custom.test", "ok"));
    assert_eq!(state(&custom), Status::Unknown);
}
#[test]
fn daemon_requires_running_and_socket_version_not_exit_zero() {
    for d in [
        serde_json::json!({}),
        serde_json::json!({"running":false}),
        serde_json::json!({"running":true}),
    ] {
        let r = derive(&[], Platform::Linux, d, None);
        assert_ne!(
            r.cards.iter().find(|c| c.id == "daemon").unwrap().status,
            Status::Passed
        );
    }
    let d = serde_json::json!({"running":true,"service":{"installed":false}});
    for (version, want) in [
        (Some("5.0.0"), Status::Passed),
        (Some("4.0.0"), Status::NeedsAttention),
        (None, Status::Unknown),
    ] {
        let r = derive(&[], Platform::Linux, d.clone(), version);
        assert_eq!(
            r.cards.iter().find(|c| c.id == "daemon").unwrap().status,
            want
        );
        assert_eq!(r.cards.last().unwrap().status, Status::NeedsAttention);
    }
}
#[test]
fn native_only_keeps_unknown_and_never_global_fixes() {
    let r = hack_desktop_core::setup_fixtures::load("native-unknown").unwrap();
    assert!(
        r.cards
            .iter()
            .filter(|c| c.id.contains("sample"))
            .all(|c| c.status == Status::Unknown && matches!(c.remedy, Remedy::Doc(_)))
    );
    assert!(!r.cards.iter().any(|c| matches!(c.remedy, Remedy::Admin(_))));
}
#[test]
fn skips_never_pass_cli_is_required_and_checks_preserve_session_skips() {
    let mut p = setup::Pane::default();
    let g = p.begin();
    p.finish(
        g,
        hack_desktop_core::setup_fixtures::load("partial").unwrap(),
    );
    p.skip("cli");
    assert!(p.skipped.is_empty());
    p.skip("trust");
    assert!(p.report.needed());
    assert!(p.skipped.contains("trust"));
    let g = p.begin();
    assert!(p.skipped.contains("trust"));
    p.finish(g - 1, Default::default());
    assert!(p.loading);
    p.finish(
        g,
        hack_desktop_core::setup_fixtures::load("missing-cli").unwrap(),
    );
    assert!(!p.report.cli_ready());
}
#[test]
fn only_explicit_trust_check_is_evidence() {
    for status in ["skipped", "warn", "error", ""] {
        let r = derive(
            &[machine(&[("local ca trust", status)])],
            Platform::Linux,
            serde_json::json!({}),
            None,
        );
        assert_ne!(
            r.cards.iter().find(|c| c.id == "trust").unwrap().status,
            Status::Passed
        );
    }
    let r = derive(
        &[machine(&[("local ca trust", "ok")])],
        Platform::Linux,
        serde_json::json!({}),
        None,
    );
    assert_eq!(
        r.cards.iter().find(|c| c.id == "trust").unwrap().status,
        Status::Passed
    );
}
#[test]
fn fixed_safe_action_argv() {
    assert_eq!(SafeAction::StartDaemon.args(), ["daemon", "start"]);
    assert_eq!(SafeAction::InstallDaemon.args(), ["daemon", "install"]);
}
#[test]
fn unsupported_cli_cannot_continue() {
    for version in [
        "4.9.0",
        "6.0.0",
        "",
        "unexpected",
        "5.bad",
        "5.0",
        "5.0.0garbage",
    ] {
        let r = setup::derive(Ok(version), None, None, None, &[], Platform::Linux);
        assert!(!r.cli_ready());
        assert!(r.needed());
    }
}
#[test]
fn inconsistent_daemon_payload_is_not_healthy_even_with_matching_socket() {
    for d in [
        serde_json::json!({"running":true,"status":"starting"}),
        serde_json::json!({"running":true,"api_compatible":false}),
        serde_json::json!({"running":true,"stale":true}),
    ] {
        let r = derive(&[], Platform::Linux, d, Some("5.0.0"));
        assert_eq!(
            r.cards.iter().find(|c| c.id == "daemon").unwrap().status,
            Status::Unknown
        );
    }
}
#[test]
fn native_project_evidence_never_leaks_between_projects() {
    use hack_desktop_core::models::{NativePs, ProjectRow};
    let projects = ProjectsPayload {
        projects: vec![
            ProjectRow {
                name: "alpha".into(),
                repo_root: Some("/work/alpha".into()),
                backend: Some("native".into()),
                native: Some(NativePs {
                    status: "observed".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
            ProjectRow {
                name: "beta".into(),
                repo_root: Some("/work/beta".into()),
                backend: Some("native".into()),
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    let runs = vec![DoctorRun::project(
        "alpha",
        "/work/alpha",
        Ok(DoctorReport {
            checks: vec![DoctorCheck {
                id: "native root trust".into(),
                status: "ok".into(),
                detail: String::new(),
            }],
            ..Default::default()
        }),
    )];
    let r = setup::derive(
        Ok("5.0.0"),
        Some(&projects),
        None,
        None,
        &runs,
        Platform::Linux,
    );
    assert_eq!(
        r.cards
            .iter()
            .find(|c| c.id == "native:alpha")
            .unwrap()
            .status,
        Status::Passed
    );
    assert_eq!(
        r.cards
            .iter()
            .find(|c| c.id == "native:beta")
            .unwrap()
            .status,
        Status::Unknown
    );
    assert_eq!(
        r.cards
            .iter()
            .find(|c| c.id == "trust:alpha")
            .unwrap()
            .status,
        Status::Passed
    );
    assert_eq!(
        r.cards
            .iter()
            .find(|c| c.id == "trust:beta")
            .unwrap()
            .status,
        Status::Unknown
    );
    assert_eq!(
        r.cards.iter().find(|c| c.id == "dns:alpha").unwrap().status,
        Status::Unknown
    );
}
#[test]
fn missing_native_project_cannot_pass_from_cached_runtime_evidence() {
    use hack_desktop_core::models::{NativePs, ProjectRow};
    let projects = ProjectsPayload {
        projects: vec![ProjectRow {
            name: "sample".into(),
            repo_root: Some("/work/sample".into()),
            status: "missing".into(),
            backend: Some("native".into()),
            native: Some(NativePs {
                status: "observed".into(),
                ..Default::default()
            }),
            ..Default::default()
        }],
        ..Default::default()
    };
    let report = setup::derive(
        Ok("5.0.0"),
        Some(&projects),
        None,
        None,
        &[],
        Platform::Linux,
    );
    assert_eq!(
        report
            .cards
            .iter()
            .find(|c| c.id == "native:sample")
            .unwrap()
            .status,
        Status::Unknown
    );
}
#[test]
fn confirmed_warnings_need_attention_and_focus_is_scoped() {
    let report = derive(
        &[machine(&[
            ("linux dns route", "warn"),
            ("local ca trust", "warn"),
        ])],
        Platform::Linux,
        serde_json::json!({}),
        None,
    );
    for id in ["routing", "trust"] {
        assert_eq!(
            report.cards.iter().find(|c| c.id == id).unwrap().status,
            Status::NeedsAttention
        );
    }
    assert!(!setup::should_recheck_on_focus(false, false, false, false));
    assert!(setup::should_recheck_on_focus(true, false, false, false));
    assert!(setup::should_recheck_on_focus(false, true, false, false));
    assert!(!setup::should_recheck_on_focus(true, true, true, false));
    assert!(!setup::should_recheck_on_focus(true, true, false, true));
}
#[test]
fn installed_but_disabled_or_drifted_login_is_not_passed() {
    for service in [
        serde_json::json!({"installed":true,"enabled":false}),
        serde_json::json!({"installed":true,"active":false}),
        serde_json::json!({"installed":true,"next_step":"hack daemon install"}),
        serde_json::json!({"installed":true,"severity":"warn"}),
    ] {
        let report = derive(
            &[],
            Platform::Linux,
            serde_json::json!({"service":service}),
            None,
        );
        assert_eq!(report.cards.last().unwrap().status, Status::NeedsAttention);
    }
}
#[test]
fn check_clears_old_output_but_preserves_immediate_action_receipt_and_skips() {
    let mut p = setup::Pane::default();
    p.result = Some("old result".into());
    p.begin();
    assert!(p.result.is_none());
    p.result = Some("just finished".into());
    p.pending_fix = true;
    p.begin();
    assert_eq!(p.result.as_deref(), Some("just finished"));
}

#[test]
fn compose_remedies_override_native_but_keep_checked_home_and_program() {
    let mut report = setup::Report::default();
    report.cards.push(setup::Card {
        id: "cli".into(),
        title: "CLI".into(),
        status: Status::Passed,
        detail: String::new(),
        remedy: setup::Remedy::Doc(String::new()),
    });
    report.cli_program = Some("/checked/hack-next".into());
    report.context = Some(
        hack_desktop_core::execution::ExecutionContext::from_values(&[
            ("HOME".into(), "/private/home".into()),
            ("HACK_RUNTIME_BACKEND".into(), "native".into()),
        ])
        .unwrap(),
    );
    for action in ["install", "trust"] {
        let spec = report
            .command(vec!["global".into(), action.into()])
            .unwrap();
        assert!(spec.args.contains(&"HACK_RUNTIME_BACKEND=compose".into()));
        assert!(spec.args.contains(&"HOME=/private/home".into()));
        assert!(spec.args.contains(&"/checked/hack-next".into()));
        assert!(!spec.args.contains(&"HACK_RUNTIME_BACKEND=native".into()));
    }
    assert!(
        report
            .command(vec!["daemon".into(), "restart".into()])
            .unwrap()
            .args
            .contains(&"HACK_RUNTIME_BACKEND=native".into())
    );
}

#[test]
fn failed_or_unloaded_launchd_never_passes_login_even_with_a_live_daemon() {
    for launchd in [
        serde_json::json!({"loaded":false}),
        serde_json::json!({"loaded":true,"exit_status":78}),
    ] {
        let report = derive(
            &[],
            Platform::Mac,
            serde_json::json!({"running":true,"service":{"installed":true,"available":true,"enabled":null,"active":true,"next_step":null}, "launchd":launchd}),
            Some("5.0.0"),
        );
        assert_eq!(report.cards.last().unwrap().status, Status::NeedsAttention);
    }
}
