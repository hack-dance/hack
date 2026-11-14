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
/// Keep platform first-launch scanning outside setup's product read deadline.
fn warm_version(program: &std::path::Path, home: &std::path::Path) {
    CliRunner::new(program)
        .with_env("HOME", home.to_str().unwrap())
        .with_env("HACK_HOME", home.join(".hack").to_str().unwrap())
        .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1")
        .version(Duration::from_secs(60))
        .unwrap();
}
#[test]
fn checks_are_observe_only_and_safe_action_does_not_prove_health() {
    let t = Tree::new();
    let program = t.0.join("fake-hack");
    let calls = t.0.join("calls");
    std::fs::write(&program,r#"#!/bin/sh
[ "$HACK_DAEMON_AUTOSTART_DISABLE" = 1 ] || exit 99
printf '%s\n' "$* backend=$HACK_RUNTIME_BACKEND" >> "$HOME/calls"
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
    warm_version(&program, &t.0);
    let runner = CliRunner::new(program)
        .with_env("HACK_RUNTIME_BACKEND", "native")
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
    assert!(read_calls.contains("doctor --json backend=compose"));
    assert!(!read_calls.contains("global"));
    assert!(!read_calls.contains("daemon start"));
    let out = source.setup_action(SafeAction::StartDaemon, &r);
    assert!(out.contains("Some(0)"));
    let r = source.setup();
    assert_eq!(
        r.cards.iter().find(|c| c.id == "daemon").unwrap().status,
        Status::NeedsAttention
    );
    source.setup_action(SafeAction::InstallDaemon, &r);
    let calls = std::fs::read_to_string(calls).unwrap();
    assert!(!calls.contains("daemon install --no-interactive"));
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
    assert!(!r.force_cli_gate, "budget exhaustion is not a missing CLI");
    assert!(!marker.exists());
    assert!(r.cards.iter().all(|c| c.status != Status::Passed));
}
#[test]
fn shared_source_recovers_after_cli_install_and_actions_use_same_executable() {
    let t = Tree::new();
    let hack = t.0.join("hack");
    let marker = t.0.join("action");
    let runner = CliRunner::on_path("hack")
        .with_env("PATH", t.0.to_str().unwrap())
        .with_env("HOME", t.0.to_str().unwrap())
        .with_env("HACK_HOME", t.0.join("home").to_str().unwrap())
        .with_env("MARKER", marker.to_str().unwrap());
    let source = LiveSource {
        runner,
        daemon: None,
    };
    assert!(!source.setup().cli_ready());
    std::fs::write(
        &hack,
        r#"#!/bin/sh
case "$1 $2" in
'--version ') printf '5.0.0-next.16';;
'daemon status') printf '{"running":false,"service":{"installed":false}}';;
'doctor --json') printf '{"ok":true,"data":{"checks":[]}}';;
'daemon start') printf action > "$HOME/action";;
*) exit 98;;
esac
"#,
    )
    .unwrap();
    std::fs::set_permissions(&hack, std::fs::Permissions::from_mode(0o700)).unwrap();
    warm_version(&hack, &t.0);
    let report = source.setup();
    assert!(report.cli_ready());
    assert_eq!(report.cli_program.as_deref(), hack.to_str());
    assert_eq!(source.cli_program().unwrap(), hack.to_str().unwrap());
    source.setup_action(SafeAction::StartDaemon, &report);
    assert!(marker.exists());
}
#[test]
fn explicit_cli_selection_is_absolute_and_never_falls_back() {
    use std::ffi::OsStr;
    assert!(
        CliRunner::selected(Some(OsStr::new("relative/hack-next")))
            .resolve_program()
            .is_err()
    );
    let t = Tree::new();
    let selected = t.0.join("candidate");
    assert_eq!(
        CliRunner::selected(Some(selected.as_os_str()))
            .resolve_program()
            .unwrap(),
        selected
    );
}
fn service_source(
    t: &Tree,
    service: serde_json::Value,
    isolated: bool,
    launch_disabled: bool,
) -> LiveSource {
    let program = t.0.join("hack");
    std::fs::write(t.0.join("status"), serde_json::to_string(&service).unwrap()).unwrap();
    std::fs::write(
        &program,
        r#"#!/bin/sh
printf '%s\n' "$*" >> "$HOME/calls"
case "$*" in
--version) printf '5.0.0';;
'daemon status --json') /bin/cat "$HOME/status";;
'doctor --json') printf '{"ok":true,"data":{"checks":[{"id":"linux dns route","status":"ok"}]}}';;
'daemon install --no-interactive') printf installed > "$HOME/action";;
*) exit 98;;
esac
"#,
    )
    .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    warm_version(&program, &t.0);
    LiveSource {
        runner: CliRunner::new(program)
            .with_env("HOME", t.0.to_str().unwrap())
            .with_env(
                "HACK_HOME",
                t.0.join(if isolated { "isolated" } else { ".hack" })
                    .to_str()
                    .unwrap(),
            )
            .with_env(
                "HACK_LAUNCHD_DISABLE",
                if launch_disabled { "1" } else { "0" },
            )
            .with_env("HACK_SYSTEMD_DISABLE", "0"),
        daemon: None,
    }
}
#[test]
fn install_needs_positive_capability_and_home_ownership_independently() {
    use hack_desktop_core::setup::Remedy;
    for (status, isolated, disabled, allowed) in [
        (serde_json::json!({"running":false}), false, false, false),
        (
            serde_json::json!({"running":false,"service":{"available":false,"installed":false}}),
            false,
            false,
            false,
        ),
        (
            serde_json::json!({"running":false,"service":{"available":true,"installed":false}}),
            false,
            false,
            true,
        ),
        (
            serde_json::json!({"running":false,"service":{"available":true,"installed":false},"socket_path":"/work/private/daemon/hackd.sock"}),
            false,
            false,
            false,
        ),
        (
            serde_json::json!({"running":false,"service":{"available":true,"installed":false}}),
            true,
            false,
            false,
        ),
        (
            serde_json::json!({"running":false,"service":{"available":true,"installed":false}}),
            false,
            true,
            false,
        ),
    ] {
        let t = Tree::new();
        let source = service_source(&t, status, isolated, disabled);
        let report = source.setup();
        assert!(report.cli_ready());
        assert_eq!(
            report.cards.last().unwrap().remedy == Remedy::Run(SafeAction::InstallDaemon),
            allowed
        );
        assert!(
            !t.0.join("action").exists(),
            "reads never install or start anything"
        );
        let result = source.setup_action(SafeAction::InstallDaemon, &report);
        let calls = std::fs::read_to_string(t.0.join("calls")).unwrap();
        assert_eq!(
            calls
                .lines()
                .filter(|l| *l == "daemon install --no-interactive")
                .count(),
            usize::from(allowed),
            "{result}"
        );
        assert_eq!(t.0.join("action").exists(), allowed);
        assert!(!calls.contains("daemon start"));
    }
}
#[test]
fn capability_disappearing_after_check_does_not_invoke_install_fallback() {
    let t = Tree::new();
    let source = service_source(
        &t,
        serde_json::json!({"running":false,"service":{"available":true,"installed":false}}),
        false,
        false,
    );
    let report = source.setup();
    std::fs::write(
        t.0.join("status"),
        r#"{"service":{"available":false,"installed":false}}"#,
    )
    .unwrap();
    assert!(
        source
            .setup_action(SafeAction::InstallDaemon, &report)
            .contains("no install was attempted")
    );
    let calls = std::fs::read_to_string(t.0.join("calls")).unwrap();
    assert!(!calls.contains("daemon install"));
    assert!(!calls.contains("daemon start"));
    assert!(!t.0.join("action").exists());
}
#[test]
fn terminal_binds_checked_path_and_context_despite_different_login_environment() {
    use hack_desktop_core::terminal::Script;
    use std::io::Write;
    let t = Tree::new();
    let _source = service_source(
        &t,
        serde_json::json!({"running":false,"service":{"available":true,"installed":false}}),
        true,
        true,
    );
    let mut source = LiveSource {
        runner: CliRunner::on_path("hack")
            .with_env("PATH", t.0.to_str().unwrap())
            .with_env("HOME", t.0.to_str().unwrap())
            .with_env("HACK_HOME", t.0.join("isolated").to_str().unwrap())
            .with_env("HACK_LAUNCHD_DISABLE", "1")
            .with_env("HACK_RUNTIME_BACKEND", "compose"),
        daemon: None,
    };
    let report = source.setup();
    source.runner = source.runner.clone().with_env("PATH", "/wrong/login/bin");
    assert!(
        source.cli_program().is_err(),
        "discovery changed after the check"
    );
    let checked = t.0.join("hack");
    // Replace only our fake's body to record execution; the selected path stays fixed.
    std::fs::write(&checked,r#"#!/bin/sh
printf '%s\n' "$HOME" "$HACK_HOME" "$HACK_RUNTIME_BACKEND" "$HACK_LAUNCHD_DISABLE" "${UNLISTED_VALUE-unset}" "$*" > "$HOME/context-receipt"
exit 7
"#).unwrap();
    let bound = report
        .command(vec!["global".into(), "trust".into()])
        .unwrap();
    assert!(bound.args.contains(&checked.to_str().unwrap().to_owned()));
    let script = Script::create(&t.0, &bound).unwrap();
    let path = script.path().to_owned();
    let mut child = std::process::Command::new("/bin/sh")
        .arg(&path)
        .env("HOME", "/wrong/login/home")
        .env("HACK_HOME", "/wrong/login/state")
        .env("HACK_RUNTIME_BACKEND", "native")
        .env("HACK_LAUNCHD_DISABLE", "0")
        .env("PATH", "/wrong/bin")
        .env("UNLISTED_VALUE", "fixture")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"\n\n").unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(7));
    let receipt = std::fs::read_to_string(t.0.join("context-receipt")).unwrap();
    assert_eq!(
        receipt.lines().collect::<Vec<_>>(),
        vec![
            t.0.to_str().unwrap(),
            t.0.join("isolated").to_str().unwrap(),
            "compose",
            "1",
            "unset",
            "global trust"
        ]
    );
    assert!(!path.exists());
}
#[test]
fn version_timeout_is_unknown_without_forcing_a_missing_cli_gate() {
    let t = Tree::new();
    let program = t.0.join("hack");
    std::fs::write(
        &program,
        "#!/bin/sh\nif [ \"$1\" = __warmup ]; then printf '{}'; exit 0; fi\nprintf '%s' \"$*\" > \"$HOME/calls\"\n/bin/sleep 5\n",
    )
    .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let source = LiveSource {
        runner: CliRunner::new(program)
            .with_env("HOME", t.0.to_str().unwrap())
            .with_env("HACK_HOME", t.0.join(".hack").to_str().unwrap())
            .with_env("HACK_DAEMON_AUTOSTART_DISABLE", "1"),
        daemon: None,
    };
    source
        .runner
        .run_json::<serde_json::Value>(&["__warmup"], None, Duration::from_secs(60))
        .unwrap();
    let report = source.read_setup_within(Duration::from_secs(3));
    assert!(!report.cli_ready());
    assert!(!report.force_cli_gate);
    assert!(report.cards[0].detail.contains("did not answer"));
    assert_eq!(
        std::fs::read_to_string(t.0.join("calls")).unwrap(),
        "--version"
    );
}
