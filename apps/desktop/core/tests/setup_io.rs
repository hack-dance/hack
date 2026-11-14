//! Live adapter exercised with fake hack only, isolated homes and no socket.
use hack_desktop_core::{
    runner::CliRunner,
    setup::{SafeAction, Status},
    source::{LiveSource, Source},
};
use std::os::unix::fs::PermissionsExt;
use std::{path::PathBuf, time::Duration};
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "setup-io-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[test]
fn checks_are_observe_only_and_safe_action_does_not_prove_health() {
    let t = Tree::new();
    let program = t.0.join("fake-hack");
    let calls = t.0.join("calls");
    std::fs::write(&program,r#"#!/bin/sh
[ "$HACK_DAEMON_AUTOSTART_DISABLE" = 1 ] || exit 99
printf '%s\n' "$*" >> "$CALLS"
case "$*" in
--version) printf '5.0.0\n';;
'projects --json --no-daemon') printf '{"projects":[],"runtime_ok":true}';;
'daemon status --json') printf '{"running":false,"service":{"installed":false}}';;
'doctor --json') printf '{"ok":true,"data":{"checks":[{"id":"linux dns route","status":"ok"},{"id":"caddy local ca","status":"ok"}]}}'; exit 1;;
'daemon start --no-interactive'|'daemon install --no-interactive') printf 'accepted';;
*) exit 98;;
esac
"#).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let runner = CliRunner::new(program)
        .with_env("CALLS", calls.to_str().unwrap())
        .with_env("HOME", t.0.to_str().unwrap())
        .with_env("HACK_HOME", t.0.join("hack").to_str().unwrap())
        .with_term_grace(Duration::from_millis(20));
    let source = LiveSource {
        runner,
        daemon: None,
    };
    let r = source.setup();
    assert_eq!(
        r.cards.iter().find(|c| c.id == "daemon").unwrap().status,
        Status::NeedsAttention
    );
    assert_eq!(
        r.cards.iter().find(|c| c.id == "trust").unwrap().status,
        Status::Unknown
    );
    let read_calls = std::fs::read_to_string(&calls).unwrap();
    assert!(
        !read_calls.contains("projects"),
        "registry-writing listing is refused"
    );
    assert!(!read_calls.contains("global"));
    assert!(!read_calls.contains("daemon start"));
    let out = source.setup_action(SafeAction::StartDaemon);
    assert!(out.contains("Some(0)"));
    let r = source.setup();
    assert_eq!(
        r.cards.iter().find(|c| c.id == "daemon").unwrap().status,
        Status::NeedsAttention
    );
    source.setup_action(SafeAction::InstallDaemon);
    let calls = std::fs::read_to_string(calls).unwrap();
    assert!(calls.contains("daemon install --no-interactive"));
    assert!(!calls.contains("sudo"));
}
#[test]
fn exhausted_budget_never_spawns_fake_cli() {
    let t = Tree::new();
    let marker = t.0.join("unexpected");
    let program = t.0.join("fake-hack");
    std::fs::write(
        &program,
        format!("#!/bin/sh\nprintf unexpected > '{}'\n", marker.display()),
    )
    .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let source = LiveSource {
        runner: CliRunner::new(program)
            .with_env("HOME", t.0.to_str().unwrap())
            .with_env("HACK_HOME", t.0.join("hack").to_str().unwrap()),
        daemon: None,
    };
    let r = source.read_setup_within(Duration::ZERO);
    assert!(!r.cli_ready());
    assert!(!marker.exists());
    assert!(r.cards.iter().all(|c| c.status != Status::Passed));
}
