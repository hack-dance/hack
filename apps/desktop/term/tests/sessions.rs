//! The session kinds, run for real on a PTY: the user's login shell with
//! its profile, and the two CLI-backed kinds through a stand-in for `hack`.
//!
//! Hermetic: `/bin/sh` and POSIX tools, an emptied environment, a private
//! temporary HOME. No Docker, no daemon, no real project.
#![cfg(unix)]

mod common;

use std::path::Path;

use common::{DEADLINE, Recorded, TempHome, fake_hack, hermetic, read_until};
use hack_desktop_term::launch::{
    BadgeTone, HackCli, LoginShell, Name, SessionKind, TermChoice, container_shell, host_shell,
    host_shell_with_env,
};
use hack_desktop_term::pty::Pty;

fn cli(home: &TempHome) -> HackCli {
    HackCli {
        program: fake_hack(home),
        project_root: home.path().to_owned(),
    }
}

/// Type a line and read its output. The terminal echoes what is typed, so
/// the end marker is computed by the shell (`fin-42`) and never appears in
/// the typed text itself.
fn ask(pty: &Pty, line: &str) -> String {
    pty.write(format!("{line}; echo fin-$((6 * 7))\n").as_bytes());
    read_until(pty, |t| t.contains("fin-42"))
}

#[test]
fn a_host_shell_is_an_interactive_login_shell_that_loads_the_users_profile() {
    let home = TempHome::new();
    // What a user's prompt theming looks like to us: the profile sets the
    // prompt and the environment, and an `ENV` file runs for interactive
    // shells. A real setup (zsh with a prompt theme) rides the same path.
    std::fs::write(
        home.path().join(".profile"),
        "echo profile-loaded\nFROM_PROFILE=yes; export FROM_PROFILE\n\
         ENV=\"$HOME/.shrc\"; export ENV\nPS1='themed-prompt> '\n",
    )
    .unwrap();
    std::fs::write(home.path().join(".shrc"), "FROM_RC=yes\n").unwrap();
    let shell = LoginShell {
        path: "/bin/sh".into(),
    };
    let mut plan = host_shell(home.path(), &shell, TermChoice::default());
    assert_eq!(plan.kind().label(), "host · sh");
    hermetic(&mut plan, &home, &[]);
    let pty = Pty::spawn(&plan.attempts[0].options).expect("spawn");
    let mut rec = Recorded::session(pty.pid());

    let start = read_until(&pty, |t| t.contains("themed-prompt> "));
    assert!(start.contains("profile-loaded"), "login shell: {start:?}");
    assert!(
        start.contains("themed-prompt> "),
        "the user's prompt: {start:?}"
    );
    let out = ask(
        &pty,
        "echo \"zero=[$0] term=[$TERM] color=[$COLORTERM] prog=[$TERM_PROGRAM] profile=[$FROM_PROFILE] rc=[$FROM_RC]\"; case $- in *i*) echo is-interactive-$((1 + 1));; esac",
    );
    assert!(
        out.contains("zero=[-sh]"),
        "argv[0] marks a login shell: {out:?}"
    );
    assert!(out.contains("is-interactive-2"), "interactive: {out:?}");
    assert!(
        out.contains("term=[xterm-256color] color=[truecolor] prog=[hack] profile=[yes] rc=[yes]"),
        "{out:?}"
    );
    // Where it starts: the project root.
    let out = ask(&pty, "echo \"cwd=[$(pwd -P)]\"");
    let root = std::fs::canonicalize(home.path()).unwrap();
    assert!(
        out.contains(&format!("cwd=[{}]", root.display())),
        "{out:?}"
    );
    assert!(pty.terminate_blocking(DEADLINE).gone);
    rec.done();
}

#[test]
fn zsh_loads_its_login_and_interactive_files_when_it_is_installed() {
    let Some(zsh) = ["/bin/zsh", "/usr/bin/zsh"]
        .into_iter()
        .find(|p| Path::new(p).is_file())
    else {
        eprintln!("zsh is not installed; skipping");
        return;
    };
    let home = TempHome::new();
    std::fs::write(home.path().join(".zprofile"), "echo zprofile-loaded\n").unwrap();
    std::fs::write(
        home.path().join(".zshrc"),
        "echo zshrc-loaded\nPROMPT='zsh-themed %# '\nalias hello='echo alias-works'\n",
    )
    .unwrap();
    let shell = LoginShell { path: zsh.into() };
    let mut plan = host_shell(home.path(), &shell, TermChoice::default());
    assert_eq!(plan.kind().label(), "host · zsh");
    hermetic(&mut plan, &home, &[]);
    let pty = Pty::spawn(&plan.attempts[0].options).expect("spawn");
    let mut rec = Recorded::session(pty.pid());
    let start = read_until(&pty, |t| t.contains("zsh-themed"));
    assert!(start.contains("zprofile-loaded"), "login: {start:?}");
    assert!(start.contains("zshrc-loaded"), "interactive: {start:?}");
    let out = ask(&pty, "hello");
    assert!(out.contains("alias-works"), "aliases from .zshrc: {out:?}");
    assert!(pty.terminate_blocking(DEADLINE).gone);
    rec.done();
}

#[test]
fn a_container_shell_runs_through_the_cli_and_is_interactive() {
    let home = TempHome::new();
    let mut plan = container_shell(&cli(&home), &Name::new("api").unwrap());
    hermetic(&mut plan, &home, &[]);
    assert_eq!(plan.kind().label(), "api · bash");
    let pty = Pty::spawn(&plan.attempts[0].options).expect("spawn");
    let mut rec = Recorded::session(pty.pid());
    let start = read_until(&pty, |t| t.contains("container$ "));
    assert!(start.contains("container:api:bash"), "{start:?}");
    let out = ask(&pty, "echo \"sum=[$((40 + 2))]\"");
    assert!(out.contains("sum=[42]"), "{out:?}");
    assert!(pty.terminate_blocking(DEADLINE).gone);
    rec.done();
}

#[test]
fn a_host_shell_with_env_is_started_by_the_cli_from_names_only() {
    let home = TempHome::new();
    std::fs::write(home.path().join(".profile"), "PS1='env-shell> '\n").unwrap();
    let shell = LoginShell {
        path: "/bin/sh".into(),
    };
    let mut plan = host_shell_with_env(
        &cli(&home),
        &shell,
        &Name::new("staging").unwrap(),
        &Name::new("api").unwrap(),
        false,
        TermChoice::default(),
    );
    hermetic(&mut plan, &home, &[]);
    let kind = plan.kind().clone();
    assert_eq!(kind.label(), "host · sh");
    let badge = kind.badge().expect("badge");
    assert_eq!(
        (badge.text.as_str(), badge.tone),
        ("env staging · api", BadgeTone::Warning)
    );
    assert!(matches!(kind, SessionKind::HostShellWithEnv { .. }));
    let pty = Pty::spawn(&plan.attempts[0].options).expect("spawn");
    let mut rec = Recorded::session(pty.pid());
    let start = read_until(&pty, |t| t.contains("env-shell> "));
    // The CLI received the names and started the login shell itself.
    assert!(
        start.contains("host-shell env=staging scope=api"),
        "{start:?}"
    );
    let out = ask(&pty, "echo \"prog=[$TERM_PROGRAM]\"");
    assert!(out.contains("prog=[hack]"), "{out:?}");
    assert!(pty.terminate_blocking(DEADLINE).gone);
    rec.done();
}
