//! The GPUI view, driven through a headless app: state changes reach the
//! next frame, and quitting the app ends every kind of session.
//!
//! The headless app draws a window when, and only when, something marked it
//! dirty, as the real app does on its next frame. No renderer or display
//! is needed.
#![cfg(all(unix, feature = "screenshots"))]

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{DEADLINE, Recorded, TempHome, sh, sh_source, tagged, wait_gone};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AnyWindowHandle, AppContext as _, ClipboardItem, Entity, Focusable as _, HeadlessAppContext,
    KeyBinding, WindowOptions,
};
use hack_desktop_term::actions::{CloseFind, Copy, Find, Paste};
use hack_desktop_term::panel::TerminalPanel;
use hack_desktop_term::pty::INPUT_QUEUE_BYTES;
use hack_desktop_term::session::{exists, is_alive};
use hack_desktop_term::view::{Status, TerminalView};

fn app() -> HeadlessAppContext {
    let mut cx = HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        Arc::new(gpui_kit::assets::Assets),
        || Ok(None),
    );
    cx.update(gpui_kit::init);
    cx
}

fn open(
    cx: &mut HeadlessAppContext,
    build: impl FnOnce(&mut gpui_kit::Context<TerminalView>) -> TerminalView + 'static,
) -> (AnyWindowHandle, Entity<TerminalView>) {
    let options = WindowOptions {
        focus: false,
        show: false,
        ..WindowOptions::default()
    };
    cx.update(|cx| gpui_kit::open_window(options, cx, |_, cx| cx.new(build)))
        .expect("open a headless window")
}

/// Everything the terminal shows, row by row.
fn screen(cx: &mut HeadlessAppContext, view: &Entity<TerminalView>) -> String {
    cx.update(|cx| {
        view.update(cx, |v, _| {
            let frame = v.emulator().frame().expect("frame");
            (0..frame.rows.len())
                .map(|r| frame.row_text(r))
                .collect::<Vec<_>>()
                .join("\n")
        })
    })
}

fn settle_until(
    cx: &mut HeadlessAppContext,
    view: &Entity<TerminalView>,
    done: impl Fn(&str) -> bool,
) -> String {
    let start = Instant::now();
    loop {
        cx.update(|cx| {
            view.update(cx, |v, cx| {
                v.settle(Duration::from_millis(50), Duration::from_secs(2), cx);
            });
        });
        let text = screen(cx, view);
        if done(&text) || start.elapsed() >= DEADLINE {
            return text;
        }
    }
}

#[test]
fn a_rejected_paste_shows_its_notice_in_the_next_frame_without_other_events() {
    let home = TempHome::new();
    let mut cx = app();
    // Raw mode and no echo: the child prints nothing in response to input,
    // and never reads it.
    let opts = sh("stty raw -echo; echo ready; exec sleep 120", &home);
    let (_window, view) = open(&mut cx, move |cx| {
        TerminalView::new_pty(&opts, cx).expect("spawn")
    });
    assert!(settle_until(&mut cx, &view, |t| t.contains("ready")).contains("ready"));
    let before = cx.update(|cx| view.read(cx).rendered().clone());
    assert!(before.count > 0 && before.notice.is_none(), "{before:?}");

    // Larger than the input queue: refused whole.
    let paste = "x".repeat(INPUT_QUEUE_BYTES + 1);
    cx.update(|cx| view.update(cx, |v, cx| v.paste_text(&paste, cx)));

    // No output arrived, nothing was pumped, no key was pressed. The one
    // thing that can have drawn a frame is the paste itself.
    let after = cx.update(|cx| view.read(cx).rendered().clone());
    assert_eq!(after.count, before.count + 1, "exactly one new frame");
    let notice = after.notice.expect("the notice is in that frame");
    assert!(notice.contains("input not sent"), "{notice}");
    assert!(
        notice.contains(&(INPUT_QUEUE_BYTES + 1).to_string()),
        "{notice}"
    );

    // Input that fits clears the notice, again in the very next frame.
    cx.update(|cx| view.update(cx, |v, cx| v.type_text("ok", cx)));
    let cleared = cx.update(|cx| view.read(cx).rendered().clone());
    assert_eq!((cleared.count, cleared.notice), (after.count + 1, None));
}

#[test]
fn the_find_count_matches_the_highlights_when_output_arrives_and_then_stops() {
    let home = TempHome::new();
    let mut cx = app();
    // One match; two more when the test says so; then silence.
    let source = sh_source(
        "echo 'needle one'; while [ ! -e go ]; do sleep 0.02; done; \
         echo 'needle two'; echo 'needle three'; exec sleep 120",
        &home,
    );
    let (_window, view) = open(&mut cx, move |cx| {
        TerminalView::new_stream(&source, 1_000, cx).expect("spawn")
    });
    assert!(settle_until(&mut cx, &view, |t| t.contains("needle one")).contains("needle one"));
    let found = cx.update(|cx| view.update(cx, |v, cx| v.search("needle", cx)));
    assert_eq!(found.total, 1);
    let before = cx.update(|cx| view.read(cx).rendered().clone());
    assert_eq!(
        (before.find.map(|f| f.total), before.highlights),
        (Some(1), 1),
        "{before:?}"
    );

    // Find is open. Output arrives that adds two matches.
    std::fs::write(home.path().join("go"), "").unwrap();
    assert!(settle_until(&mut cx, &view, |t| t.contains("needle three")).contains("needle three"));

    // The source is quiet now: nothing more is pumped, typed or clicked.
    // The last frame is the one drawn for the output that arrived, and its
    // count has to be right already, because no later frame is coming.
    let after = cx.update(|cx| view.read(cx).rendered().clone());
    assert_eq!(after.highlights, 3, "all three are on screen: {after:?}");
    assert_eq!(
        after.find.map(|f| f.total),
        Some(after.highlights),
        "the count shown is the number of highlighted matches: {after:?}"
    );
    let later = cx.update(|cx| view.read(cx).rendered().clone());
    assert_eq!(later, after, "and no further frame was drawn to get there");
}

#[test]
fn redrawing_an_unchanged_view_with_find_open_does_not_run_the_search() {
    let home = TempHome::new();
    let mut cx = app();
    let source = sh_source(
        "echo 'needle one'; echo 'needle two'; exec sleep 120",
        &home,
    );
    let (_window, view) = open(&mut cx, move |cx| {
        TerminalView::new_stream(&source, 1_000, cx).expect("spawn")
    });
    assert!(settle_until(&mut cx, &view, |t| t.contains("needle two")).contains("needle two"));
    let found = cx.update(|cx| view.update(cx, |v, cx| v.search("needle", cx)));
    assert_eq!(found.total, 2);
    // The frame for the search has been drawn. The source is quiet.
    let runs = |cx: &mut HeadlessAppContext| {
        cx.update(|cx| view.update(cx, |v, _| v.emulator().search_runs()))
    };
    let (searched, before) = (
        runs(&mut cx),
        cx.update(|cx| view.read(cx).rendered().clone()),
    );
    assert_eq!((before.find, before.highlights), (Some(found), 2));

    // Redraw three times with nothing changed, as a hover, a blink or a
    // neighbouring view's update would.
    for _ in 0..3 {
        cx.update(|cx| view.update(cx, |_, cx| cx.notify()));
    }
    let after = cx.update(|cx| view.read(cx).rendered().clone());
    assert_eq!(after.count, before.count + 3, "three more frames");
    assert_eq!(
        (after.find, after.highlights),
        (Some(found), 2),
        "showing the same count and highlights"
    );
    assert_eq!(runs(&mut cx), searched, "and the search did no work");
}

#[test]
fn quitting_the_app_ends_a_stream_process_that_ignores_sigterm_and_its_descendant() {
    let home = TempHome::new();
    let mut cx = app();
    // Both the process and its child ignore SIGTERM, so only the awaited
    // quit teardown's SIGKILL can end them.
    let script =
        "trap '' TERM; ( trap '' TERM; exec sleep 120 ) & echo \"kid=$!\"; echo \"sh=$$\"; wait";
    let source = sh_source(script, &home);
    let (_window, view) = open(&mut cx, move |cx| {
        TerminalView::new_stream(&source, 10_000, cx).expect("open")
    });
    let text = settle_until(&mut cx, &view, |t| t.contains("sh="));
    let kid = tagged(&text, "kid").expect("kid");
    let leader = tagged(&text, "sh").expect("sh");
    let mut rec = Recorded::session(leader.unsigned_abs());
    assert!(is_alive(kid) && is_alive(leader));

    cx.update(|cx| cx.shutdown());

    // The quit handler was awaited: by the time shutdown returns the
    // session has been killed and reaped.
    assert!(
        !is_alive(kid) && !is_alive(leader),
        "left running after quit"
    );
    assert!(!exists(leader), "the process was not reaped");
    assert!(wait_gone(&[kid, leader]).is_empty());
    rec.done();
}

#[test]
fn quitting_the_app_ends_a_pty_session_that_ignores_hangup() {
    let home = TempHome::new();
    let mut cx = app();
    let opts = sh(
        "trap '' HUP TERM; ( trap '' HUP TERM; exec sleep 120 ) & echo \"kid=$!\"; echo \"sh=$$\"; wait",
        &home,
    );
    let (_window, view) = open(&mut cx, move |cx| {
        TerminalView::new_pty(&opts, cx).expect("spawn")
    });
    let text = settle_until(&mut cx, &view, |t| t.contains("sh="));
    let kid = tagged(&text, "kid").expect("kid");
    let leader = tagged(&text, "sh").expect("sh");
    let mut rec = Recorded::session(leader.unsigned_abs());
    assert!(is_alive(kid) && is_alive(leader));

    cx.update(|cx| cx.shutdown());

    assert!(
        !is_alive(kid) && !is_alive(leader),
        "left running after quit"
    );
    assert!(!exists(leader), "the shell was not reaped");
    rec.done();
}

#[test]
fn quitting_right_after_closing_a_tab_ends_what_the_tab_left_running() {
    let home = TempHome::new();
    let mut cx = app();
    let options = WindowOptions {
        focus: false,
        show: false,
        ..WindowOptions::default()
    };
    let (window, panel) = cx
        .update(|cx| gpui_kit::open_window(options, cx, |_, cx| cx.new(TerminalPanel::new)))
        .expect("open a headless window");
    // The shell and its child ignore the hangup and SIGTERM, so only
    // SIGKILL ends them, and the reaper sends that after a grace period
    // longer than GPUI's whole shutdown window.
    let opts = sh(
        "trap '' HUP TERM; ( trap '' HUP TERM; exec sleep 120 ) & echo \"kid=$!\"; echo \"sh=$$\"; wait",
        &home,
    );
    let view = cx.update(|cx| cx.new(|cx| TerminalView::new_pty(&opts, cx).expect("spawn")));
    cx.update_window(window, |_, window, cx| {
        panel.update(cx, |p, cx| p.add_tab(view.clone(), window, cx));
    })
    .expect("add the tab");
    let text = settle_until(&mut cx, &view, |t| t.contains("sh="));
    let kid = tagged(&text, "kid").expect("kid");
    let leader = tagged(&text, "sh").expect("sh");
    let mut rec = Recorded::session(leader.unsigned_abs());
    assert!(is_alive(kid) && is_alive(leader));

    cx.update_window(window, |_, window, cx| {
        panel.update(cx, |p, cx| p.close_active(window, cx));
    })
    .expect("close the tab");
    cx.update(|cx| cx.shutdown());

    // The closed tab's teardown was hurried and awaited: when shutdown
    // returns, the session has been killed and reaped.
    assert!(
        !is_alive(kid) && !is_alive(leader),
        "a closed tab's processes outlived the app"
    );
    assert!(!exists(leader), "the closed tab's shell was not reaped");
    rec.done();
}

/// Pump until the view's source has ended, or the deadline.
fn settle_until_ended(cx: &mut HeadlessAppContext, view: &Entity<TerminalView>) {
    let start = Instant::now();
    while start.elapsed() < DEADLINE {
        cx.update(|cx| {
            view.update(cx, |v, cx| {
                v.settle(Duration::from_millis(20), Duration::from_millis(200), cx);
            });
        });
        if cx.update(|cx| view.read(cx).status() != &Status::Running) {
            return;
        }
    }
    panic!("the source did not end");
}

#[test]
fn quitting_right_after_a_stream_closes_its_output_ends_the_process_still_running() {
    let home = TempHome::new();
    let mut cx = app();
    // The stream closes its output and keeps running, ignoring SIGTERM, so
    // the end of output starts a teardown that only SIGKILL completes.
    let script =
        "trap '' TERM; echo \"sh=$$\"; exec >&- 2>&-; ( trap '' TERM; exec sleep 120 ) & wait";
    let source = sh_source(script, &home);
    let (_window, view) = open(&mut cx, move |cx| {
        TerminalView::new_stream(&source, 1_000, cx).expect("open")
    });
    let text = settle_until(&mut cx, &view, |t| t.contains("sh="));
    let leader = tagged(&text, "sh").expect("sh");
    let mut rec = Recorded::session(leader.unsigned_abs());
    settle_until_ended(&mut cx, &view);
    assert!(is_alive(leader), "still running after its output closed");

    cx.update(|cx| cx.shutdown());

    assert!(!is_alive(leader), "the process outlived the app");
    assert!(!exists(leader), "the process was not reaped");
    rec.done();
}

#[test]
fn quitting_right_after_closing_an_ended_tab_ends_what_its_session_left_running() {
    let home = TempHome::new();
    let mut cx = app();
    let options = WindowOptions {
        focus: false,
        show: false,
        ..WindowOptions::default()
    };
    let (window, panel) = cx
        .update(|cx| gpui_kit::open_window(options, cx, |_, cx| cx.new(TerminalPanel::new)))
        .expect("open a headless window");
    // The shell exits and leaves a job that ignores the hangup and SIGTERM
    // and does not hold the terminal, so the session ends by itself. The
    // shell ignores both before starting the job, which inherits that, so
    // the hangup at the shell's exit cannot reach the job before its trap.
    let opts = sh(
        "trap '' HUP TERM; ( exec sleep 120 ) </dev/null >/dev/null 2>&1 & echo \"kid=$!\"; echo \"sh=$$\"",
        &home,
    );
    let view = cx.update(|cx| cx.new(|cx| TerminalView::new_pty(&opts, cx).expect("spawn")));
    cx.update_window(window, |_, window, cx| {
        panel.update(cx, |p, cx| p.add_tab(view.clone(), window, cx));
    })
    .expect("add the tab");
    let text = settle_until(&mut cx, &view, |t| t.contains("sh="));
    let kid = tagged(&text, "kid").expect("kid");
    let leader = tagged(&text, "sh").expect("sh");
    let mut rec = Recorded::session(leader.unsigned_abs());
    settle_until_ended(&mut cx, &view);
    assert!(
        is_alive(kid),
        "the job is still running after the session ended"
    );

    cx.update_window(window, |_, window, cx| {
        panel.update(cx, |p, cx| p.close_active(window, cx));
    })
    .expect("close the tab");
    cx.update(|cx| cx.shutdown());

    assert!(!is_alive(kid), "the ended session's job outlived the app");
    rec.done();
}

#[test]
fn paste_with_find_open_goes_into_the_query_and_never_reaches_the_program() {
    let home = TempHome::new();
    let mut cx = app();
    let opts = sh("read line; echo \"got=[$line]\"; exec sleep 120", &home);
    let (window, view) = open(&mut cx, move |cx| {
        TerminalView::new_pty(&opts, cx).expect("spawn")
    });
    focus(&mut cx, window, &view);
    let dispatch = |cx: &mut HeadlessAppContext, action: Box<dyn gpui_kit::Action>| {
        cx.update_window(window, |_, window, cx| window.dispatch_action(action, cx))
            .expect("dispatch");
    };

    dispatch(&mut cx, Box::new(Find));
    // A newline here would run whatever the program has read so far.
    cx.update(|cx| cx.write_to_clipboard(ClipboardItem::new_string("needle\nrm -x\t".into())));
    dispatch(&mut cx, Box::new(Paste));
    assert_eq!(
        cx.update(|cx| view.read(cx).find_query().to_owned()),
        "needle rm -x ",
        "the paste is the query, on one line"
    );

    // The program got nothing: the first line it reads is the next paste,
    // made after find is closed.
    dispatch(&mut cx, Box::new(CloseFind));
    cx.update(|cx| cx.write_to_clipboard(ClipboardItem::new_string("after\n".into())));
    dispatch(&mut cx, Box::new(Paste));
    let text = settle_until(&mut cx, &view, |t| t.contains("got=["));
    assert!(text.contains("got=[after]"), "{text:?}");
}

/// Focus the terminal and draw, so key events and actions are routed to it.
fn focus(cx: &mut HeadlessAppContext, window: AnyWindowHandle, view: &Entity<TerminalView>) {
    cx.update_window(window, |_, window, cx| {
        let handle = view.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        window.render_frame(cx);
    })
    .expect("focus");
}

fn press(cx: &mut HeadlessAppContext, window: AnyWindowHandle, key: &str) {
    cx.update_window(window, |_, window, cx| window.press(key, cx))
        .expect("press");
}

fn find_open(cx: &mut HeadlessAppContext, view: &Entity<TerminalView>) -> bool {
    cx.update(|cx| view.read(cx).find_open())
}

#[test]
fn the_crate_binds_no_keys_and_copy_paste_and_find_are_actions() {
    let home = TempHome::new();
    let mut cx = app();
    let opts = sh("read line; echo \"got=[$line]\"; exec sleep 120", &home);
    let (window, view) = open(&mut cx, move |cx| {
        TerminalView::new_pty(&opts, cx).expect("spawn")
    });
    focus(&mut cx, window, &view);

    // With nothing bound, the usual chords are only keys: they do not open
    // find, and nothing in the crate treats them as shortcuts.
    for chord in ["ctrl-shift-f", "cmd-f"] {
        press(&mut cx, window, chord);
        assert!(!find_open(&mut cx, &view), "{chord} is not a shortcut here");
    }

    // The actions do the work.
    cx.update_window(window, |_, window, cx| {
        window.dispatch_action(Box::new(Find), cx);
    })
    .unwrap();
    assert!(find_open(&mut cx, &view), "Find opens the find field");
    cx.update_window(window, |_, window, cx| {
        window.dispatch_action(Box::new(CloseFind), cx);
    })
    .unwrap();
    assert!(!find_open(&mut cx, &view));

    // Paste: the clipboard goes to the program.
    cx.update(|cx| cx.write_to_clipboard(ClipboardItem::new_string("hello-paste\n".into())));
    cx.update_window(window, |_, window, cx| {
        window.dispatch_action(Box::new(Paste), cx);
    })
    .unwrap();
    let text = settle_until(&mut cx, &view, |t| t.contains("got=[hello-paste]"));
    assert!(text.contains("got=[hello-paste]"), "{text:?}");

    // Copy: the selection goes to the clipboard.
    cx.update(|cx| {
        view.update(cx, |v, _| v.emulator().select_all());
        cx.write_to_clipboard(ClipboardItem::new_string(String::new()));
    });
    cx.update_window(window, |_, window, cx| {
        window.dispatch_action(Box::new(Copy), cx);
    })
    .unwrap();
    let copied = cx
        .update(|cx| cx.read_from_clipboard().and_then(|c| c.text()))
        .unwrap_or_default();
    assert!(copied.contains("got=[hello-paste]"), "{copied:?}");

    // A key becomes a shortcut only when the app binds it.
    cx.update(|cx| cx.bind_keys([KeyBinding::new("ctrl-shift-f", Find, Some("Terminal"))]));
    press(&mut cx, window, "ctrl-shift-f");
    assert!(find_open(&mut cx, &view), "bound by the app, it opens find");
}
