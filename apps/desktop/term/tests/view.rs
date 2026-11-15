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
use gpui_kit::{AnyWindowHandle, AppContext as _, Entity, HeadlessAppContext, WindowOptions};
use hack_desktop_term::pty::INPUT_QUEUE_BYTES;
use hack_desktop_term::session::{exists, is_alive};
use hack_desktop_term::view::TerminalView;

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
