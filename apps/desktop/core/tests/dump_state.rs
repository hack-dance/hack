//! Runs the real `hack-desktop-state` binary against a fake `hack` on PATH,
//! and a private fake daemon, and checks the JSON.
//! Hermetic: no real Hack home, daemon, Docker or network.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;

fn temp_dir(tag: &str) -> PathBuf {
    // Short on macOS too: the daemon socket must fit in sockaddr_un.
    let d = PathBuf::from("/tmp").join(format!(
        "hack-desktop-dump-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(&d).unwrap();
    d
}

fn serve_snapshot(home: &std::path::Path) -> std::thread::JoinHandle<()> {
    use std::io::{Read, Write};
    use std::os::unix::{fs::DirBuilderExt, net::UnixListener};
    let dir = home.join("daemon");
    std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
    let listener = UnixListener::bind(dir.join("hackd.sock")).unwrap();
    listener.set_nonblocking(true).unwrap();
    std::thread::spawn(move || {
        let bodies = [
            r#"{"status":"ok","version":"5.0.0"}"#,
            r#"{"runtime_ok":true,"projects":[{"name":"alpha","status":"running","repo_root":"/work/alpha","defined_services":["api"],"runtime":{"services":[{"service":"api","containers":[{"state":"running","status":"Up 5 minutes"}]}]}},{"name":"beta","status":"stopped","repo_root":"/work/beta","defined_services":["web"]}]}"#,
        ];
        for body in bodies {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(pair) => break pair,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < deadline =>
                    {
                        std::thread::sleep(std::time::Duration::from_millis(5))
                    }
                    Err(e) => panic!("fake daemon accept failed or timed out: {e}"),
                }
            };
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut request = [0; 4096];
            let n = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..n]).starts_with("GET /v1/"));
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        }
    })
}

#[test]
fn dump_state_reads_the_cli_like_the_app_and_prints_view_models() {
    let bin = temp_dir("bin");
    let home = temp_dir("home");
    let hack = bin.join("hack");
    let server = serve_snapshot(&home);
    std::fs::write(
        &hack,
        r#"#!/bin/sh
case "$1" in
  --version) echo "hack v5.0.0" ;;
  projects) echo called > "$HACK_HOME/unsafe-listing"; exit 2 ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
"#,
    )
    .unwrap();
    std::fs::set_permissions(&hack, std::fs::Permissions::from_mode(0o755)).unwrap();

    let out = Command::new(env!("CARGO_BIN_EXE_hack-desktop-state"))
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
        .env("HACK_HOME", &home)
        .env("HOME", &home)
        .env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
        .env_remove("HACK_DESKTOP_CLI")
        .output()
        .unwrap();
    server.join().unwrap();
    assert!(
        !home.join("unsafe-listing").exists(),
        "no registry-writing fallback"
    );
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
    assert_eq!(v["source"]["daemon"]["version"], "5.0.0");
    assert_eq!(v["list"]["phase"]["phase"], "ready");
    assert_eq!(v["list"]["banners"], serde_json::json!([]));
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
        .env("HOME", &empty)
        .env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
        .env_remove("HACK_DESKTOP_CLI")
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&empty);
    assert!(out.status.success());
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["source"]["ok"], false);
    assert_eq!(v["list"]["phase"]["phase"], "cli_missing");
}

#[test]
fn missing_daemon_never_runs_the_registry_writing_cli_listing() {
    let home = temp_dir("observe");
    let hack = home.join("hack");
    std::fs::write(&hack, "#!/bin/sh\ncase \"$1\" in --version) echo 'hack v5.0.0';; *) echo called > \"$HACK_HOME/unexpected\"; exit 1;; esac\n").unwrap();
    std::fs::set_permissions(&hack, std::fs::Permissions::from_mode(0o700)).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_hack-desktop-state"))
        .env("PATH", &home)
        .env("HOME", &home)
        .env("HACK_HOME", &home)
        .env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
        .env_remove("HACK_DESKTOP_CLI")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(!home.join("unexpected").exists());
    let body: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(body["source"]["ok"], false);
    assert!(
        body["source"]["error"]
            .as_str()
            .unwrap()
            .contains("hackd is off")
    );
    assert_eq!(body["list"]["phase"]["phase"], "error");
    std::fs::remove_dir_all(home).unwrap();
}

#[test]
fn daemon_recovery_runs_only_the_requested_command_and_checks_its_exit() {
    use hack_desktop_core::runner::CliRunner;
    use hack_desktop_core::source::{DaemonRecovery, LiveSource, Source};
    let home = temp_dir("recover");
    let hack = home.join("hack");
    std::fs::write(&hack, "#!/bin/sh\nprintf '%s' \"$*\" > \"$HACK_HOME/called\"\nif [ \"$2\" = restart ]; then echo 'daemon could not restart' >&2; exit 1; fi\n").unwrap();
    std::fs::set_permissions(&hack, std::fs::Permissions::from_mode(0o700)).unwrap();
    let source = LiveSource {
        runner: CliRunner::new(hack)
            .with_env("HOME", home.to_str().unwrap())
            .with_env("HACK_HOME", home.to_str().unwrap())
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1"),
        daemon: None,
    };
    assert!(!home.join("called").exists());
    source.recover_daemon(DaemonRecovery::Start).unwrap();
    assert_eq!(
        std::fs::read_to_string(home.join("called")).unwrap(),
        "daemon start"
    );
    let error = source.recover_daemon(DaemonRecovery::Restart).unwrap_err();
    assert!(error.contains("daemon could not restart"));
    assert_eq!(
        std::fs::read_to_string(home.join("called")).unwrap(),
        "daemon restart"
    );
    std::fs::remove_dir_all(home).unwrap();
}

#[test]
fn setup_fixture_cli_never_resolves_hack() {
    let home = temp_dir("setup-offline");
    let output = Command::new(env!("CARGO_BIN_EXE_hack-desktop-state"))
        .args(["--setup-fixture", "native-unknown"])
        .env("PATH", &home)
        .env("HOME", &home)
        .env("HACK_HOME", &home)
        .env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
        .env_remove("HACK_DESKTOP_CLI")
        .env_remove("HACK_DESKTOP_CLI")
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&home);
    assert!(output.status.success());
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        report["cards"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == "native:sample" && c["status"] == "Unknown")
    );
}
