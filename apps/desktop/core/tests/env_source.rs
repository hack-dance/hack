//! Env observation against a fake executable only; no owner registry or daemon.
use hack_desktop_core::{
    env::EnvView,
    runner::CliRunner,
    source::{LiveSource, Source},
};
use std::os::unix::fs::PermissionsExt;

#[test]
fn names_only_native_read_accepts_exit_one_and_redacts_failures() {
    let dir = std::env::temp_dir().join(format!(
        "desktop-env-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    let project = dir.join("project");
    std::fs::create_dir_all(project.join(".hack")).unwrap();
    std::fs::write(project.join(".hack/hack.project.json"), "{}").unwrap();
    let project = std::fs::canonicalize(project).unwrap();
    let exe = dir.join("hack");
    std::fs::write(&exe, r#"#!/bin/sh
[ "$#" = 5 ] || exit 2
[ "$1 $2 $3 $4" = 'env list --json --path' ] || exit 2
[ "$5" = "$EXPECTED_ROOT" ] || exit 2
[ "$HOME" = "$HACK_HOME" ] || exit 2
[ "$HACK_DAEMON_AUTOSTART_DISABLE" = 1 ] || exit 2
if [ "$HACK_RUNTIME_BACKEND" = native ]; then
  echo '{"vars":[],"missing_required":["API_TOKEN"],"key_state":"unreadable","value":"SECRET_SENTINEL","materialized":{"API_TOKEN":"SECRET_SENTINEL"}}'
else
  echo 'SECRET_SENTINEL' >&2
  echo '{"error":"SECRET_SENTINEL"}'
fi
exit 1
"#).unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
    let source = LiveSource {
        cache: Default::default(),
        runner: CliRunner::new(exe)
            .with_env("EXPECTED_ROOT", project.to_str().unwrap())
            .with_env("HOME", dir.to_str().unwrap())
            .with_env("HACK_HOME", dir.to_str().unwrap())
            .with_env("HACK_RUNTIME_BACKEND", "compose"),
        daemon: None,
    };
    let report = source.env(&project, true);
    assert!(
        matches!(&report, EnvView::Report(r) if r.vars[0].missing && r.vars[0].key == "API_TOKEN")
    );
    assert!(!format!("{report:?}").contains("SECRET_SENTINEL"));
    assert_eq!(source.env(&project, false), EnvView::Unreadable);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn missing_and_shadowed_nested_roots_never_launch_env_read() {
    let dir = std::env::temp_dir().join(format!(
        "desktop-env-roots-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let parent = dir.join("parent");
    let nested = parent.join("nested");
    std::fs::create_dir_all(parent.join(".hack")).unwrap();
    std::fs::create_dir(&nested).unwrap();
    std::fs::write(parent.join(".hack/docker-compose.yml"), "services: {}\n").unwrap();
    let called = dir.join("called");
    let exe = dir.join("hack");
    std::fs::write(
        &exe,
        r#"#!/bin/sh
printf x >> "$CALL_LOG"
echo '{"vars":[],"missing_required":[]}'
"#,
    )
    .unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
    let source = LiveSource {
        cache: Default::default(),
        runner: CliRunner::new(exe)
            .with_env("HOME", dir.to_str().unwrap())
            .with_env("HACK_HOME", dir.to_str().unwrap())
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
            .with_env("CALL_LOG", called.to_str().unwrap()),
        daemon: None,
    };
    assert_eq!(source.env(&nested, false), EnvView::Unreadable);
    assert_eq!(source.env(&dir.join("missing"), false), EnvView::Unreadable);
    // A nested .dev project is shadowed by an ancestor's primary .hack project.
    std::fs::create_dir(nested.join(".dev")).unwrap();
    std::fs::write(nested.join(".dev/docker-compose.yml"), "services: {}\n").unwrap();
    assert_eq!(source.env(&nested, false), EnvView::Unreadable);
    assert!(!called.exists(), "no CLI read for missing/shadowed roots");
    // An exact primary marker restores a usable, names-only read.
    std::fs::create_dir(nested.join(".hack")).unwrap();
    std::fs::write(nested.join(".hack/docker-compose.yml"), "services: {}\n").unwrap();
    assert!(matches!(source.env(&nested, false), EnvView::Report(_)));
    assert_eq!(std::fs::read_to_string(called).unwrap(), "x");
    std::fs::remove_dir_all(dir).unwrap();
}

/// A fake-only project and CLI for the per-value read.
fn value_fixture(script: &str) -> (std::path::PathBuf, std::path::PathBuf, LiveSource) {
    let dir = std::env::temp_dir().join(format!(
        "desktop-env-value-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    let project = dir.join("project");
    std::fs::create_dir_all(project.join(".hack")).unwrap();
    std::fs::write(project.join(".hack/docker-compose.yml"), "services: {}\n").unwrap();
    let project = std::fs::canonicalize(project).unwrap();
    let exe = dir.join("hack");
    std::fs::write(&exe, script).unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
    let source = LiveSource {
        cache: Default::default(),
        runner: CliRunner::new(exe)
            .with_env("EXPECTED_ROOT", project.to_str().unwrap())
            .with_env("HOME", dir.to_str().unwrap())
            .with_env("HACK_HOME", dir.to_str().unwrap()),
        daemon: None,
    };
    (dir, project, source)
}

#[test]
fn one_value_is_read_with_hack_env_get_for_the_chosen_overlay_and_scope() {
    use hack_desktop_core::source::EnvTarget;
    let (dir, project, source) = value_fixture(
        r#"#!/bin/sh
[ "$*" = "env get API_TOKEN --env staging --service api --path $EXPECTED_ROOT" ] || { echo "argv: $*" >&2; exit 2; }
[ "$HACK_DAEMON_AUTOSTART_DISABLE" = 1 ] || exit 2
printf 'fake-value-not-a-secret'
"#,
    );
    let selection = EnvTarget {
        env: Some("staging".into()),
        scope: Some("api".into()),
    };
    let value = source
        .env_value(&project, false, &selection, "API_TOKEN")
        .expect("read");
    assert_eq!(value.expose(), "fake-value-not-a-secret");
    assert!(
        !format!("{value:?}").contains("fake-value"),
        "Debug never prints the value"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_failed_value_read_never_puts_output_in_its_error_and_odd_names_never_run() {
    use hack_desktop_core::source::EnvTarget;
    let (dir, project, source) = value_fixture(
        r#"#!/bin/sh
echo called >> "$HOME/calls"
printf 'SECRET_SENTINEL'
echo 'SECRET_SENTINEL' >&2
exit 1
"#,
    );
    let error = source
        .env_value(&project, false, &EnvTarget::default(), "API_TOKEN")
        .expect_err("exit 1 is a failure");
    assert!(!error.contains("SECRET_SENTINEL"), "{error}");
    assert!(error.contains("API_TOKEN"), "{error}");
    let calls = || {
        std::fs::read_to_string(dir.join("calls"))
            .unwrap_or_default()
            .lines()
            .count()
    };
    assert_eq!(calls(), 1);
    // Names that could be read as options or paths never reach the CLI.
    for (env, scope, key) in [
        (Some("--show-values"), None, "API_TOKEN"),
        (None, Some("-x"), "API_TOKEN"),
        (Some("../x"), None, "API_TOKEN"),
        (None, None, "--show-values"),
        (None, None, "A B"),
    ] {
        let selection = EnvTarget {
            env: env.map(Into::into),
            scope: scope.map(Into::into),
        };
        assert!(source.env_value(&project, false, &selection, key).is_err());
        assert!(
            matches!(
                source.env_for(&project, false, &selection),
                EnvView::Unreadable
            ) || env.is_none() && scope.is_none()
        );
    }
    // The first read, then the plain listing for each of the two cases with
    // no overlay or scope; never `env get` with an odd name.
    assert_eq!(calls(), 3);
    std::fs::remove_dir_all(dir).unwrap();
}
