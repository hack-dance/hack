//! The terminal core end to end: a real child on a PTY, its output in the
//! emulator's grid and scrollback.
#![cfg(all(unix, feature = "ghostty"))]

mod common;

use std::time::{Duration, Instant};

use common::{DEADLINE, TempHome, fake_hack, hermetic, sh, sh_source};
use hack_desktop_term::launch::{HackCli, Name, SessionKind, container_shell};
use hack_desktop_term::stream::StreamSource;
use hack_desktop_term::terminal::{SETTLE_MAX, Status, TerminalCore};

fn pump_to_end(core: &mut TerminalCore) {
    let start = Instant::now();
    while *core.status() == Status::Running && start.elapsed() < DEADLINE {
        if !core.pump() {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    assert!(
        matches!(core.status(), Status::Ended(_)),
        "{:?}",
        core.status()
    );
}

/// The last non-empty row of the viewport.
fn last_line(core: &mut TerminalCore) -> String {
    let frame = core.emulator().frame().unwrap();
    (0..frame.rows.len())
        .rev()
        .map(|r| frame.row_text(r))
        .find(|t| !t.is_empty())
        .unwrap_or_default()
}

#[test]
fn a_short_command_keeps_its_final_output_in_the_grid() {
    let home = TempHome::new();
    // The child exits right after a large output. Its exit is visible well
    // before the output has been pumped.
    let mut core =
        TerminalCore::pty(&sh("seq 1 200000; echo final-suffix-7f3a", &home)).expect("spawn");
    pump_to_end(&mut core);
    assert_eq!(
        *core.status(),
        Status::Ended("process ended (exit status 0)".into())
    );
    assert_eq!(last_line(&mut core), "final-suffix-7f3a");
    let emu = core.emulator();
    assert_eq!(emu.search(Some("final-suffix-7f3a")).total, 1);
    // The line before it is the last number, so nothing was cut off.
    assert_eq!(emu.search(Some("200000")).total, 1);
    assert!(emu.scrollback_rows() >= 9_000, "scrollback kept the tail");

    // The same with a tiny output and a consumer that starts late.
    let mut core = TerminalCore::pty(&sh("echo tiny-suffix-91c2", &home)).expect("spawn");
    std::thread::sleep(Duration::from_millis(300));
    pump_to_end(&mut core);
    assert_eq!(last_line(&mut core), "tiny-suffix-91c2");
}

#[test]
fn a_descendant_holding_the_terminal_does_not_keep_it_open_for_ever() {
    let home = TempHome::new();
    // The shell exits; a background job keeps the terminal open and silent.
    let mut core = TerminalCore::pty(&sh("sleep 120 & echo shell-done", &home)).expect("spawn");
    let start = Instant::now();
    pump_to_end(&mut core);
    assert!(
        start.elapsed() < Duration::from_secs(30),
        "bounded wait for end of output"
    );
    assert_eq!(core.emulator().search(Some("shell-done")).total, 1);
    assert!(matches!(core.status(), Status::Ended(s) if s.contains("exit status 0")));
}

#[test]
fn a_stream_ends_with_its_last_line_in_the_grid() {
    let home = TempHome::new();
    let mut core = TerminalCore::stream(
        &sh_source("seq 1 50000; echo stream-suffix-4d", &home),
        10_000,
    )
    .expect("open");
    pump_to_end(&mut core);
    assert_eq!(*core.status(), Status::Ended("end of stream".into()));
    assert_eq!(last_line(&mut core), "stream-suffix-4d");
}

/// Pump until the screen shows `needle`, the session ends, or the deadline.
fn pump_until(core: &mut TerminalCore, needle: &str) -> String {
    let start = Instant::now();
    loop {
        if !core.pump() {
            std::thread::sleep(Duration::from_millis(2));
        }
        let frame = core.emulator().frame().unwrap();
        let text = (0..frame.rows.len())
            .map(|r| frame.row_text(r))
            .collect::<Vec<_>>()
            .join("\n");
        if text.contains(needle) || *core.status() != Status::Running || start.elapsed() >= DEADLINE
        {
            return text;
        }
    }
}

fn container_plan(
    home: &TempHome,
    extra: &[(&str, &str)],
) -> hack_desktop_term::launch::SessionPlan {
    let cli = HackCli {
        program: fake_hack(home),
        project_root: home.path().to_owned(),
    };
    let mut plan = container_shell(&cli, &Name::new("api").unwrap());
    hermetic(&mut plan, home, extra);
    plan
}

#[test]
fn a_container_without_bash_falls_back_to_sh_and_the_tab_says_so() {
    let home = TempHome::new();
    let mut core =
        TerminalCore::session(container_plan(&home, &[("FAKE_HACK_NO_BASH", "1")])).expect("spawn");
    assert_eq!(core.kind().label(), "api · bash", "bash is tried first");
    let first = core.leader().expect("the bash attempt's leader");
    let screen = pump_until(&mut core, "container:api:sh");
    assert!(screen.contains("container:api:sh"), "{screen:?}");
    assert_eq!(
        core.kind().label(),
        "api · sh",
        "the label follows the shell"
    );
    assert_eq!(*core.status(), Status::Running);
    // Both attempts' leaders are kept, so a caller can account for what
    // each session left running.
    let now = core.leader().expect("the sh attempt's leader");
    assert_ne!(now, first);
    assert_eq!(core.leaders(), [first, now]);
    assert!(
        !screen.contains("not found"),
        "the failed attempt's message is cleared: {screen:?}"
    );
    // The shell that started is usable.
    core.send(b"echo \"sum=[$((40 + 2))]\"\n");
    assert!(pump_until(&mut core, "sum=[42]").contains("sum=[42]"));
}

#[test]
fn typing_while_a_container_tab_opens_does_not_cancel_the_fallback_to_sh() {
    let home = TempHome::new();
    let mut core =
        TerminalCore::session(container_plan(&home, &[("FAKE_HACK_NO_BASH", "1")])).expect("spawn");
    // A fast typist: input before the bash attempt has printed or failed.
    core.send(b"echo \"typed=[$((1 + 2))]\"\n");
    let screen = pump_until(&mut core, "typed=[3]");
    assert_eq!(
        core.kind().label(),
        "api · sh",
        "bash was missing, so sh started"
    );
    assert!(
        screen.contains("typed=[3]"),
        "the held input reached sh: {screen:?}"
    );
    assert_eq!(*core.status(), Status::Running);
}

/// When, relative to a failing `bash` attempt, the user types.
#[derive(Clone, Copy, Debug)]
enum TypedAt {
    /// Straight after the tab opens, before the first pump.
    Opening,
    /// While the attempt has printed nothing and [`SETTLE_MAX`] has passed:
    /// a slow `docker exec`.
    SilentPastSettleMax,
    /// As the error appears, while the attempt is still alive.
    WithTheError,
    /// After the attempt exited, before any pump saw the exit.
    ExitedUnseen,
    /// After a pump saw the exit, while the session drains its output.
    ExitSeen,
}

fn pump_for(core: &mut TerminalCore, span: Duration) -> String {
    let start = Instant::now();
    while start.elapsed() < span {
        if !core.pump() {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    screen_text(core)
}

fn screen_text(core: &mut TerminalCore) -> String {
    let frame = core.emulator().frame().unwrap();
    (0..frame.rows.len())
        .map(|r| frame.row_text(r))
        .collect::<Vec<_>>()
        .join("\n")
}

/// A `bash` attempt that fails with 127 after `fail_after` seconds (and
/// exits `exit_after` seconds after its message), with the user typing at
/// `at`. The fallback to `sh` must happen and the typed command run there.
fn fallback_with_input(at: TypedAt, fail_after: &str, exit_after: &str) {
    let home = TempHome::new();
    let mark = home.path().join("bash-attempt-exiting");
    let mark_str = mark.to_str().unwrap().to_owned();
    let mut extra = vec![
        ("FAKE_HACK_NO_BASH", "1"),
        ("FAKE_HACK_EXIT_MARK", mark_str.as_str()),
    ];
    if !fail_after.is_empty() {
        extra.push(("FAKE_HACK_FAIL_AFTER", fail_after));
    }
    if !exit_after.is_empty() {
        extra.push(("FAKE_HACK_EXIT_AFTER", exit_after));
    }
    let mut core = TerminalCore::session(container_plan(&home, &extra)).expect("spawn");
    let typed: &[u8] = b"echo \"typed=[$((4 + 5))]\"\n";
    match at {
        TypedAt::Opening => core.send(typed),
        TypedAt::SilentPastSettleMax => {
            pump_for(&mut core, SETTLE_MAX + Duration::from_millis(300));
            assert_eq!(
                core.kind().label(),
                "api · bash",
                "{at:?}: still the first attempt"
            );
            core.send(typed);
        }
        TypedAt::WithTheError => {
            pump_until(&mut core, "executable file not found");
            core.send(typed);
        }
        TypedAt::ExitedUnseen | TypedAt::ExitSeen => {
            pump_until(&mut core, "executable file not found");
            // Let the attempt exit without pumping, so nothing has seen it.
            // A sent-too-early input would count as typed and fail the test,
            // so the slack can only cause a false failure, never a pass.
            let start = Instant::now();
            while !mark.exists() && start.elapsed() < DEADLINE {
                std::thread::sleep(Duration::from_millis(5));
            }
            std::thread::sleep(Duration::from_millis(300));
            if matches!(at, TypedAt::ExitSeen) {
                core.pump();
                assert_eq!(*core.status(), Status::Running, "{at:?}: still draining");
            }
            core.send(typed);
        }
    }
    let screen = pump_until(&mut core, "typed=[9]");
    assert_eq!(
        core.kind().label(),
        "api · sh",
        "{at:?}: fell back: {screen:?}"
    );
    assert!(
        screen.contains("typed=[9]"),
        "{at:?}: the input reached sh: {screen:?}"
    );
    assert_eq!(*core.status(), Status::Running, "{at:?}");
}

#[test]
fn typing_at_the_opening_of_a_slow_failing_bash_still_falls_back() {
    fallback_with_input(TypedAt::Opening, "3", "");
}

#[test]
fn typing_while_a_slow_bash_attempt_is_silent_past_settle_max_still_falls_back() {
    fallback_with_input(TypedAt::SilentPastSettleMax, "3", "");
}

#[test]
fn typing_as_the_bash_error_appears_still_falls_back_when_the_exit_lags() {
    // The exit is observed a little after the message, within the
    // settle time: input typed meanwhile is held, not sent to bash.
    fallback_with_input(TypedAt::WithTheError, "", "0.3");
}

#[test]
fn typing_after_bash_exited_but_before_a_pump_saw_it_still_falls_back() {
    fallback_with_input(TypedAt::ExitedUnseen, "", "0.7");
}

#[test]
fn typing_while_the_failed_bash_attempt_drains_still_falls_back() {
    fallback_with_input(TypedAt::ExitSeen, "", "0.7");
}

#[test]
fn a_paste_refused_while_input_is_held_keeps_its_notice_after_the_flush() {
    use hack_desktop_term::pty::INPUT_QUEUE_BYTES;
    let home = TempHome::new();
    let mut core =
        TerminalCore::session(container_plan(&home, &[("FAKE_HACK_NO_BASH", "1")])).expect("spawn");
    core.send(b"echo \"typed=[$((2 + 3))]\"\n");
    core.send(&vec![b'#'; INPUT_QUEUE_BYTES + 1]);
    let refused = core
        .notice()
        .map(str::to_owned)
        .expect("the oversized paste is refused");
    assert!(refused.contains("input limit"), "{refused}");
    pump_until(&mut core, "typed=[5]");
    assert_eq!(
        core.notice(),
        Some(refused.as_str()),
        "delivering the held input does not clear the refusal"
    );
}

#[test]
fn a_container_with_bash_keeps_it_and_a_later_exit_127_is_not_a_fallback() {
    let home = TempHome::new();
    let mut core = TerminalCore::session(container_plan(&home, &[])).expect("spawn");
    let screen = pump_until(&mut core, "container$");
    assert!(screen.contains("container:api:bash"), "{screen:?}");
    assert_eq!(
        *core.kind(),
        SessionKind::ContainerShell {
            service: "api".into(),
            shell: "bash".into()
        }
    );
    // The user runs something and the shell exits 127: that is their
    // session ending, not a missing shell. No second attempt.
    core.send(b"exit 127\n");
    pump_to_end(&mut core);
    assert_eq!(
        *core.status(),
        Status::Ended("process ended (exit status 127)".into())
    );
    assert_eq!(core.kind().label(), "api · bash");
}

#[test]
fn logs_keep_their_ansi_colours_and_prompt_glyphs_exactly() {
    let home = TempHome::new();
    // A log line with SGR colours, a truecolour value, an OSC 8 link and
    // the private-use glyphs a Nerd Font prompt uses.
    let line = "\x1b[1;31mERROR\x1b[0m \x1b[38;2;10;200;30mok\x1b[0m \u{e0b0}\u{f418} \x1b]8;;https://example.invalid/a\x1b\\link\x1b]8;;\x1b\\\n";
    let path = home.path().join("app.log");
    std::fs::write(&path, line).unwrap();
    let mut core = TerminalCore::stream(&StreamSource::File(path), 10_000).expect("open");
    pump_to_end(&mut core);
    assert_eq!(core.kind().label(), "logs");
    assert!(core.read_only());
    let frame = core.emulator().frame().unwrap();
    let row = &frame.rows[0];
    assert_eq!(frame.row_text(0), "ERROR ok \u{e0b0}\u{f418} link");
    // Colours are the ones the service printed, not ours.
    assert!(row[0].bold);
    assert_ne!(row[0].fg, frame.foreground, "SGR 31");
    assert_eq!(
        row[6].fg,
        hack_desktop_term::emulator::Rgb::new(10, 200, 30)
    );
    // Each prompt glyph is one cell holding exactly that character.
    assert_eq!((row[9].text.as_str(), row[9].wide), ("\u{e0b0}", false));
    assert_eq!(row[10].text, "\u{f418}");
    assert_eq!(
        core.emu().link_at(12, 0).as_deref(),
        Some("https://example.invalid/a")
    );
    // Input is never sent to a log stream.
    core.send(b"anything\n");
    assert!(core.notice().is_none());
}
