//! The terminal core end to end: a real child on a PTY, its output in the
//! emulator's grid and scrollback.
#![cfg(all(unix, feature = "ghostty"))]

mod common;

use std::time::{Duration, Instant};

use common::{DEADLINE, TempHome, sh, sh_source};
use hack_desktop_term::terminal::{Status, TerminalCore};

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
    let mut core = TerminalCore::pty(&sh("sleep 300 & echo shell-done", &home)).expect("spawn");
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
