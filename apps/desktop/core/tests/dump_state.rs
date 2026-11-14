//! Runs the real `hack-desktop-state` binary against a fake `hack` on PATH,
//! with a temporary HACK_HOME (no daemon socket), and checks the JSON.
//! Hermetic: no real Hack home, daemon, Docker or network.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "hack-desktop-dump-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn dump_state_reads_the_cli_like_the_app_and_prints_view_models() {
    let bin = temp_dir("bin");
    let home = temp_dir("home");
    let hack = bin.join("hack");
    std::fs::write(
        &hack,
        r#"#!/bin/sh
case "$1" in
  --version) echo "hack v5.0.0" ;;
  projects) echo '{"runtime_ok":true,"projects":[{"name":"alpha","status":"running","repo_root":"/work/alpha","defined_services":["api"],"runtime":{"services":[{"service":"api","containers":[{"state":"running","status":"Up 5 minutes"}]}]}},{"name":"beta","status":"stopped","repo_root":"/work/beta","defined_services":["web"]}]}' ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
"#,
    )
    .unwrap();
    std::fs::set_permissions(&hack, std::fs::Permissions::from_mode(0o755)).unwrap();

    let out = Command::new(env!("CARGO_BIN_EXE_hack-desktop-state"))
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
        .env("HACK_HOME", &home)
        .env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&bin);
    let _ = std::fs::remove_dir_all(&home);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();

    assert_eq!(v["source"]["ok"], true);
    assert_eq!(v["source"]["cli_version"], "5.0.0");
    assert!(v["source"]["daemon"].is_null(), "no socket: CLI fallback");
    assert_eq!(v["list"]["phase"]["phase"], "ready");
    assert_eq!(v["list"]["banners"][0]["banner"], "daemon_off");
    assert_eq!(v["list"]["running"][0]["name"], "alpha");
    assert_eq!(v["list"]["stopped"][0]["name"], "beta");
    let details = v["details"].as_array().unwrap();
    assert_eq!(details.len(), 2);
    assert_eq!(details[0]["name"], "alpha");
    assert_eq!(details[0]["state"]["state"], "running");
    assert_eq!(details[0]["services"][0]["name"], "api");
    assert_eq!(details[1]["state"]["state"], "stopped");
}

#[test]
fn dump_state_without_hack_reports_the_missing_cli() {
    let empty = temp_dir("empty");
    let out = Command::new(env!("CARGO_BIN_EXE_hack-desktop-state"))
        .env("PATH", empty.display().to_string())
        .env("HACK_HOME", &empty)
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&empty);
    assert!(out.status.success());
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["source"]["ok"], false);
    assert_eq!(v["list"]["phase"]["phase"], "cli_missing");
}
