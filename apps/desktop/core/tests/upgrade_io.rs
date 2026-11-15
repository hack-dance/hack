//! Fake executables only; all homes and command receipts live in owned scratch.
use hack_desktop_core::{
    runner::CliRunner,
    source::{LiveSource, Source},
    upgrade::*,
    upgrade_io,
};
use std::{os::unix::fs::PermissionsExt, path::PathBuf};
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "upgrade-io-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn runner(&self, data: &str, exit: i32) -> CliRunner {
        std::fs::write(self.0.join("data"), data).unwrap();
        let program = self.0.join("fake-cli");
        std::fs::write(
            &program,
            format!(
                r#"#!/bin/sh
[ "$HACK_DAEMON_AUTOSTART_DISABLE" = 1 ] || exit 97
[ "$PWD" = / ] || exit 98
printf '%s\n' "$*" >> "$CALLS"
if [ "$*" = 'version --json' ]; then printf '{{"ok":true,"data":{{"schema":"hack.version.v1","version":"5.0.0"}}}}\n'; exit 0; fi
/bin/cat "$DATA"
exit {exit}
"#
            ),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        CliRunner::new(program)
            .with_env("DATA", self.0.join("data").to_str().unwrap())
            .with_env("CALLS", self.0.join("calls").to_str().unwrap())
            .with_env("HOME", self.0.to_str().unwrap())
            .with_env("HACK_HOME", self.0.join("hack").to_str().unwrap())
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
const REPORT: &str = r#"{"ok":true,"data":{"report_version":2,"host_probes":"enabled","ready":false,"machine":[],"projects":[],"registry":{"state":"absent","total":0,"live":0,"missing":[],"unreadable":[],"unchecked":[],"rejected":0},"blockers":[{"scope":"machine","id":"docker","summary":"Docker could not be checked"}],"incomplete":[],"plan":[]}}"#;
#[test]
fn nonzero_valid_check_envelope_is_retained_without_update_or_other_effects() {
    let t = Tree::new();
    let source = LiveSource {
        runner: t.runner(REPORT, 1),
        daemon: None,
    };
    let observation = source.upgrade_check().unwrap();
    assert!(!observation.report.unwrap().ready());
    assert_eq!(observation.cli.as_deref(), Some("5.0.0"));
    assert!(observation.app.is_none());
    let calls = std::fs::read_to_string(t.0.join("calls")).unwrap();
    assert_eq!(
        calls,
        "upgrade check --json\nversion --json\ndaemon status --json\n"
    );
}
#[test]
fn malformed_envelopes_missing_required_fields_and_unsupported_version_are_refused() {
    let t = Tree::new();
    for (data, exit) in [
        ("{}", 0),
        ("not json", 0),
        (
            r#"{"ok":false,"error":{"message":"private output must not be echoed"}}"#,
            1,
        ),
        (r#"{"ok":true,"data":{"ready":true}}"#, 0),
    ] {
        let error =
            upgrade_io::read::<Report>(&t.runner(data, exit), &["upgrade", "check", "--json"])
                .unwrap_err();
        assert!(!error.contains("private output"));
    }
    // Version 1 never shipped in a release; 3 is not yet defined.
    for version in ["1", "3"] {
        let source = LiveSource {
            runner: t.runner(
                &REPORT.replace(
                    "\"report_version\":2",
                    &format!("\"report_version\":{version}"),
                ),
                0,
            ),
            daemon: None,
        };
        assert!(source.upgrade_check().is_err());
    }
    // A version 2 plan step without its grouped fields is not an observation.
    let stepless = REPORT.replace(
        "\"plan\":[]",
        r#""plan":[{"id":"snapshot","scope":"machine","why":"Save files","args":["upgrade","snapshot"],"action":null}]"#,
    );
    assert!(
        upgrade_io::read::<Report>(&t.runner(&stepless, 0), &["upgrade", "check", "--json"])
            .is_err()
    );
}
/// Produced by the CLI's own `runUpgradeCheck` (three checkouts, two legacy
/// env configs), with scratch paths replaced by `/example`.
const CHECK_V2: &str = include_str!("fixtures/upgrade/check-v2.json");
#[test]
fn current_cli_v2_report_is_read_with_grouped_plan_targets() {
    let t = Tree::new();
    let source = LiveSource {
        runner: t.runner(CHECK_V2, 0),
        daemon: None,
    };
    let observation = source.upgrade_check().unwrap();
    let report = observation.report.unwrap();
    assert_eq!(report.report_version, REPORT_VERSION);
    assert!(report.readable());
    assert!(report.ready());
    let steps: Vec<_> = report
        .plan
        .iter()
        .map(|s| (s.id.as_str(), s.scope.as_str(), s.count))
        .collect();
    assert_eq!(
        steps,
        [
            ("snapshot", "machine", 0),
            ("env-format", "projects", 2),
            ("ignore-rules", "projects", 3)
        ]
    );
    let ignore = &report.plan[2];
    assert_eq!(
        ignore
            .targets
            .iter()
            .map(|t| t.scope.as_str())
            .collect::<Vec<_>>(),
        ["alpha", "beta", "gamma"]
    );
    // Plan argv is only ever displayed quoted.
    assert_eq!(
        display_step("/example/bin/hack", ignore.args.as_ref().unwrap()).unwrap(),
        "'/example/bin/hack' 'upgrade' 'apply' '--only' 'ignore-rules'"
    );
    let calls = std::fs::read_to_string(t.0.join("calls")).unwrap();
    assert_eq!(
        calls,
        "upgrade check --json\nversion --json\ndaemon status --json\n"
    );
}
#[test]
fn snapshots_and_rollback_are_explicit_and_use_exact_manifest_without_overwrite() {
    let t = Tree::new();
    let runner = t.runner(r#"{"ok":true,"data":{"status":"created","id":"example","manifest_path":"/example/snapshots/example/manifest.json","complete":true,"gaps":[],"files":[{"path":"/example/file","label":"names only"}]}}"#,0);
    let snapshot = upgrade_io::snapshot(&runner).unwrap();
    assert!(snapshot.manifest().is_some());
    let runner = t.runner(r#"{"ok":true,"data":{"status":"incomplete","results":[{"path":"/example/file","status":"conflict","kept_as":"/example/file.kept","message":"File changed"}]}}"#,1);
    let result = upgrade_io::rollback(&runner, &snapshot).unwrap();
    assert_eq!(
        result.results[0].kept_as.as_deref(),
        Some("/example/file.kept")
    );
    let calls = std::fs::read_to_string(t.0.join("calls")).unwrap();
    assert_eq!(
        calls,
        "upgrade snapshot --json\nupgrade rollback --rollback-manifest /example/snapshots/example/manifest.json --json\n"
    );
    let mut incomplete = snapshot;
    incomplete.complete = Some(false);
    assert!(upgrade_io::rollback(&runner, &incomplete).is_err());
    assert_eq!(std::fs::read_to_string(t.0.join("calls")).unwrap(), calls);
    let refused: Snapshot = upgrade_io::snapshot(&t.runner(
        r#"{"ok":true,"data":{"status":"refused","message":"refused"}}"#,
        1,
    ))
    .unwrap();
    assert!(refused.manifest().is_none());
}

#[test]
fn app_evidence_is_installed_version_not_catalog_version() {
    let t = Tree::new();
    // The fake read runner requires neutral cwd and disabled autostart too.
    let make = |data: &str| {
        t.runner(data, 0)
            .with_cwd("/")
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
    };
    assert_eq!(
        upgrade_io::installed_app(&make(
            r#"{"casks":[{"token":"hack-desktop","version":"5.1.0","installed":"5.0.0"}]}"#
        ))
        .unwrap(),
        "5.0.0"
    );
    for data in [
        r#"{"casks":[{"token":"hack-desktop","version":"5.1.0","installed":null}]}"#,
        r#"{"casks":[{"token":"other","installed":"5.1.0"}]}"#,
        r#"{"casks":[]}"#,
    ] {
        assert!(upgrade_io::installed_app(&make(data)).is_err());
    }
}

#[test]
fn any_normal_nonzero_exit_retains_a_valid_envelope() {
    let t = Tree::new();
    let report: Report =
        upgrade_io::read(&t.runner(REPORT, 7), &["upgrade", "check", "--json"]).unwrap();
    assert!(!report.ready());
}
#[test]
fn readiness_reads_the_daemon_version_from_the_cli_socket_path() {
    use std::io::{Read, Write};
    let t = Tree::new();
    let socket_dir = PathBuf::from(format!(
        "/tmp/uio-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    std::fs::create_dir(&socket_dir).unwrap();
    std::fs::set_permissions(&socket_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let sock = socket_dir.join("hackd.sock");
    let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(60)))
            .unwrap();
        let mut buf = [0; 1024];
        let n = stream.read(&mut buf).unwrap();
        assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /v1/status "));
        let body = r#"{"status":"ok","version":"5.0.0"}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
    });
    let program = t.0.join("fake-cli");
    std::fs::write(
        &program,
        format!(
            r#"#!/bin/sh
case "$*" in
'version --json') printf '{{"ok":true,"data":{{"schema":"hack.version.v1","version":"5.0.0"}}}}\n';;
'daemon status --json') printf '{{"status":"running","running":true,"socket_path":"{}"}}';;
*) /bin/cat "$DATA";;
esac
"#,
            sock.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(t.0.join("data"), REPORT).unwrap();
    let source = LiveSource {
        runner: CliRunner::new(program)
            .with_env("DATA", t.0.join("data").to_str().unwrap())
            .with_env("HOME", t.0.to_str().unwrap())
            .with_env("HACK_HOME", t.0.join("hack").to_str().unwrap()),
        daemon: None,
    };
    let observation = source.upgrade_check().unwrap();
    assert_eq!(observation.daemon.as_deref(), Some("5.0.0"));
    server.join().unwrap();
    let _ = std::fs::remove_dir_all(socket_dir);
}
