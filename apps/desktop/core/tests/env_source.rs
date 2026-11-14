//! Env observation against a fake executable only; no owner registry or daemon.
use hack_desktop_core::{
    env::EnvView,
    runner::CliRunner,
    source::{LiveSource, Source},
};
use std::{os::unix::fs::PermissionsExt, path::Path};

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
    let exe = dir.join("hack");
    std::fs::write(&exe, r#"#!/bin/sh
[ "$*" = 'env list --json --path /work/example' ] || exit 2
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
        runner: CliRunner::new(exe)
            .with_env("HOME", dir.to_str().unwrap())
            .with_env("HACK_HOME", dir.to_str().unwrap())
            .with_env("HACK_RUNTIME_BACKEND", "compose"),
        daemon: None,
    };
    let report = source.env(Path::new("/work/example"), true);
    assert!(
        matches!(&report, EnvView::Report(r) if r.vars[0].missing && r.vars[0].key == "API_TOKEN")
    );
    assert!(!format!("{report:?}").contains("SECRET_SENTINEL"));
    assert_eq!(
        source.env(Path::new("/work/example"), false),
        EnvView::Unreadable
    );
    std::fs::remove_dir_all(dir).unwrap();
}
