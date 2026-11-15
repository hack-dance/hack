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
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        // A private PATH directory with one trusted tool, so reads have a
        // hermetic PATH instead of the test process's own.
        let bin = path.join("bin");
        std::fs::create_dir(&bin).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        let git = bin.join("git");
        std::fs::write(&git, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    /// Fake CLI. Only the checked context reaches it, so its inputs live
    /// under HOME (the tree) rather than in ad hoc environment variables.
    fn runner(&self, data: &str, exit: i32) -> CliRunner {
        std::fs::write(self.0.join("data"), data).unwrap();
        let program = self.0.join("fake-cli");
        std::fs::write(
            &program,
            format!(
                r#"#!/bin/sh
[ "$HACK_DAEMON_AUTOSTART_DISABLE" = 1 ] || exit 97
[ "$PWD" = / ] || exit 98
printf '%s\n' "$*" >> "$HOME/calls"
printf '%s|%s|%s|%s\n' "$*" "$PATH" "${{BASH_ENV-unset}}" "$(/bin/ls "$PATH" 2>/dev/null | /usr/bin/tr '\n' ' ')" >> "$HOME/env"
printf '%s|%s=%s|%s=%s|%s|%s\n' "${{GIT_CONFIG_COUNT-unset}}" "${{GIT_CONFIG_KEY_0-}}" "${{GIT_CONFIG_VALUE_0-}}" "${{GIT_CONFIG_KEY_1-}}" "${{GIT_CONFIG_VALUE_1-}}" "${{HACK_HOST_PROBES_DISABLE-unset}}" "${{HACK_NATIVE_BINARY-unset}}" >> "$HOME/guards"
if [ "$*" = 'version --json' ]; then printf '{{"ok":true,"data":{{"schema":"hack.version.v1","version":"5.0.0"}}}}\n'; exit 0; fi
/bin/cat "$HOME/data"
exit {exit}
"#
            ),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        CliRunner::new(program)
            .with_env("HOME", self.0.to_str().unwrap())
            .with_env("HACK_HOME", self.0.join("hack").to_str().unwrap())
            .with_env("PATH", self.0.join("bin").to_str().unwrap())
    }
    fn source(&self, data: &str, exit: i32) -> LiveSource {
        LiveSource {
            runner: self.runner(data, exit),
            daemon: None,
        }
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
    let source = t.source(REPORT, 1);
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
        let source = t.source(
            &REPORT.replace(
                "\"report_version\":2",
                &format!("\"report_version\":{version}"),
            ),
            0,
        );
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
    let source = t.source(CHECK_V2, 0);
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
    let source = t.source(r#"{"ok":true,"data":{"status":"created","id":"example","manifest_path":"/example/snapshots/example/manifest.json","complete":true,"gaps":[],"files":[{"path":"/example/file","label":"names only"}]}}"#,0);
    let snapshot = upgrade_io::snapshot(&source).unwrap();
    assert!(snapshot.manifest().is_some());
    let source = t.source(r#"{"ok":true,"data":{"status":"incomplete","results":[{"path":"/example/file","status":"conflict","kept_as":"/example/file.kept","message":"File changed"}]}}"#,1);
    let result = upgrade_io::rollback(&source, &snapshot).unwrap();
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
    assert!(upgrade_io::rollback(&source, &incomplete).is_err());
    assert_eq!(std::fs::read_to_string(t.0.join("calls")).unwrap(), calls);
    let refused: Snapshot = upgrade_io::snapshot(&t.source(
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
*) /bin/cat "$HOME/data";;
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
            .with_env("HOME", t.0.to_str().unwrap())
            .with_env("HACK_HOME", t.0.join("hack").to_str().unwrap())
            .with_env("PATH", t.0.join("bin").to_str().unwrap()),
        daemon: None,
    };
    let observation = source.upgrade_check().unwrap();
    assert_eq!(observation.daemon.as_deref(), Some("5.0.0"));
    server.join().unwrap();
    let _ = std::fs::remove_dir_all(socket_dir);
}

/// Every upgrade read and write runs the CLI with only Doctor's private
/// wrapper PATH (alive for the whole operation) and no interpreter startup
/// variables, and the observation keeps the context copied commands use.
#[test]
fn upgrade_operations_see_only_the_private_tool_path_and_no_startup_variables() {
    let t = Tree::new();
    let source = LiveSource {
        runner: t.runner(REPORT, 1).with_env("BASH_ENV", "/example/startup"),
        daemon: None,
    };
    let observation = source.upgrade_check().unwrap();
    let context = observation.context.as_ref().expect("checked context");
    assert_eq!(context.value("HACK_HOME"), t.0.join("hack").to_str());
    assert_eq!(context.value("PATH"), t.0.join("bin").to_str());
    let manifest = r#"{"ok":true,"data":{"status":"created","id":"example","manifest_path":"/example/snapshots/example/manifest.json","complete":true,"gaps":[],"files":[]}}"#;
    std::fs::write(t.0.join("data"), manifest).unwrap();
    let snapshot = source.upgrade_snapshot().unwrap();
    std::fs::write(
        t.0.join("data"),
        r#"{"ok":true,"data":{"status":"restored","results":[]}}"#,
    )
    .unwrap();
    source.upgrade_rollback(&snapshot).unwrap();
    let env = std::fs::read_to_string(t.0.join("env")).unwrap();
    let lines: Vec<_> = env.lines().collect();
    assert_eq!(lines.len(), 5, "{env}");
    for line in lines {
        let [args, path, bash_env, listing] = line.splitn(4, '|').collect::<Vec<_>>()[..] else {
            panic!("unexpected receipt: {line}");
        };
        assert!(
            !path.contains(':'),
            "{args}: one private directory, got {path}"
        );
        let dir = std::path::Path::new(path);
        assert!(
            dir.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("hack-desktop-tools-"),
            "{args}: {path}"
        );
        assert_ne!(dir, t.0.join("bin"));
        assert_eq!(bash_env, "unset", "{args}");
        assert_eq!(
            listing.trim(),
            "dirname git",
            "{args}: wrappers (git, plus dirname for candidate launchers) exist while the CLI runs"
        );
        assert!(!dir.exists(), "{args}: wrappers are removed afterwards");
    }
}

/// `upgrade check` runs Git in registered checkouts: every upgrade CLI run
/// carries Doctor's command-line Git overrides (fsmonitor off, hooks to
/// /dev/null; proved against real Git by Doctor's
/// `doctor_git_reads_disable_repository_fsmonitor`). The CLI's host-probe hard
/// deny survives into the checked run and copied commands, and the native
/// runtime is pinned to the checked selection.
#[test]
fn upgrade_runs_keep_git_overrides_and_the_host_probe_guard() {
    let t = Tree::new();
    let source = LiveSource {
        runner: t
            .runner(REPORT, 1)
            .with_env("HACK_HOST_PROBES_DISABLE", "1"),
        daemon: None,
    };
    let observation = source.upgrade_check().unwrap();
    let context = observation.context.as_ref().expect("checked context");
    assert_eq!(context.value("HACK_HOST_PROBES_DISABLE"), Some("1"));
    let copied = observation
        .copy_command(&["upgrade".into(), "check".into()])
        .expect("copied command");
    assert!(copied.contains("HACK_HOST_PROBES_DISABLE=1"), "{copied}");
    let guards = std::fs::read_to_string(t.0.join("guards")).unwrap();
    assert!(!guards.is_empty());
    for line in guards.lines() {
        let [count, fsmonitor, hooks, probes, native] = line.split('|').collect::<Vec<_>>()[..]
        else {
            panic!("unexpected receipt: {line}");
        };
        assert_eq!(count, "2");
        assert_eq!(fsmonitor, "core.fsmonitor=false");
        assert_eq!(hooks, "core.hooksPath=/dev/null");
        assert_eq!(probes, "1", "the host-probe hard deny reaches the CLI");
        // The fake CLI is a #! script, so its fallback is pinned absent.
        assert!(native.ends_with("/hack-native-unavailable"), "{native}");
    }
    // Without the guard the run does not invent one.
    let t = Tree::new();
    let source = LiveSource {
        runner: t.runner(REPORT, 1),
        daemon: None,
    };
    let observation = source.upgrade_check().unwrap();
    assert_eq!(
        observation
            .context
            .as_ref()
            .unwrap()
            .value("HACK_HOST_PROBES_DISABLE"),
        None
    );
    let guards = std::fs::read_to_string(t.0.join("guards")).unwrap();
    assert!(guards.lines().all(|l| l.split('|').nth(3) == Some("unset")));
}
#[test]
fn an_unsafe_tool_on_path_fails_every_upgrade_operation_closed() {
    let t = Tree::new();
    let shared = t.0.join("shared");
    std::fs::create_dir(&shared).unwrap();
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o700)).unwrap();
    let docker = shared.join("docker");
    std::fs::write(&docker, "#!/bin/sh\nexit 0\n").unwrap();
    // Writable by other users: it cannot be trusted to stand for docker.
    std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o777)).unwrap();
    let path = format!("{}:{}", shared.display(), t.0.join("bin").display());
    let source = LiveSource {
        runner: t.runner(REPORT, 0).with_env("PATH", &path),
        daemon: None,
    };
    let error = source.upgrade_check().unwrap_err();
    assert!(error.contains("docker"), "{error}");
    assert!(error.contains("other users can change"), "{error}");
    assert!(
        !error.contains("R14") && !error.contains("Doctor"),
        "{error}"
    );
    let error = source.upgrade_snapshot().unwrap_err();
    assert!(error.contains("docker"), "{error}");
    let complete = Snapshot {
        status: "created".into(),
        id: Some("example".into()),
        manifest_path: Some("/example/snapshots/example/manifest.json".into()),
        complete: Some(true),
        gaps: Some(vec![]),
    };
    assert!(source.upgrade_rollback(&complete).is_err());
    assert!(
        !t.0.join("calls").exists(),
        "the CLI never ran with an unchecked tool on PATH"
    );
}
#[test]
fn a_remote_docker_endpoint_fails_every_upgrade_operation_closed() {
    let t = Tree::new();
    let source = LiveSource {
        runner: t
            .runner(REPORT, 0)
            .with_env("PATH", t.0.join("bin").to_str().unwrap())
            .with_env("DOCKER_HOST", "ssh://user@example"),
        daemon: None,
    };
    let error = source.upgrade_check().unwrap_err();
    assert!(error.contains("remote endpoint"), "{error}");
    assert!(source.upgrade_snapshot().is_err());
    assert!(
        !t.0.join("calls").exists(),
        "the CLI never ran with a remote Docker endpoint"
    );
}
