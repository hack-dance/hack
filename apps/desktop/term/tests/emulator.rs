//! libghostty-vt behaviour the terminal surface relies on, read back
//! through the same `Frame` the GPUI element paints.
#![cfg(all(unix, feature = "ghostty"))]

use hack_desktop_term::emulator::{Emulator, EmulatorOptions, Frame, Rgb, SearchState};

fn emu(cols: u16, rows: u16, crlf: bool) -> Emulator {
    Emulator::new(EmulatorOptions {
        cols,
        rows,
        scrollback_lines: 10_000,
        newline_is_crlf: crlf,
        ..EmulatorOptions::default()
    })
    .expect("emulator")
}

fn lines(range: std::ops::Range<usize>) -> Vec<u8> {
    range
        .flat_map(|i| format!("line {i}\n").into_bytes())
        .collect()
}

#[test]
fn ansi_colours_and_attributes_reach_the_frame() {
    let mut e = emu(40, 4, true);
    e.feed(b"\x1b[31mred\x1b[0m \x1b[1;38;2;1;2;3mrgb\x1b[0m \x1b[7minv\x1b[0m\n");
    let f = e.frame().unwrap();
    let row = &f.rows[0];
    assert_eq!(f.row_text(0), "red rgb inv");
    let palette_red = row[0].fg;
    assert_ne!(palette_red, f.foreground, "SGR 31 changes the foreground");
    assert_eq!(row[4].fg, Rgb::new(1, 2, 3));
    assert!(row[4].bold);
    // Inverse swaps default colours.
    assert_eq!(row[8].bg, Some(f.foreground));
    assert_eq!(row[8].fg, f.background);
}

#[test]
fn bare_newlines_start_a_new_line_in_stream_mode() {
    let mut e = emu(20, 3, true);
    e.feed(b"ab\ncd\n");
    let f = e.frame().unwrap();
    assert_eq!(f.row_text(0), "ab");
    assert_eq!(f.row_text(1), "cd", "LNM: LF also returns the carriage");
}

#[test]
fn scrollback_is_bounded_and_follow_tracks_the_newest_line() {
    let mut e = emu(40, 10, true);
    e.feed(&lines(0..30_000));
    let held = e.scrollback_rows();
    // Bounded at 10,000 lines, pruned at page granularity.
    assert!((9_000..=12_000).contains(&held), "scrollback rows: {held}");
    let f = e.frame().unwrap();
    assert_eq!(f.row_text(8), "line 29999", "follow shows the newest line");
    assert!(e.at_bottom());
    // The oldest lines were pruned.
    assert_eq!(e.search(Some("line 5 ")).total, 0);
}

#[test]
fn the_line_bound_holds_on_a_wide_grid() {
    // libghostty's default byte limit would keep only about 5,500 lines at
    // this width; the line bound is the one that must apply.
    let mut e = emu(200, 60, true);
    e.feed(&lines(0..30_000));
    let held = e.scrollback_rows();
    assert!((9_000..=12_000).contains(&held), "scrollback rows: {held}");
}

#[test]
fn ten_thousand_lines_with_follow_off_keep_the_viewport_still() {
    let mut e = emu(40, 10, true);
    e.feed(&lines(0..10_000));
    e.scroll(-50);
    assert!(!e.follow(), "scrolling up turns follow off");
    let before = e.frame().unwrap();
    e.feed(&lines(10_000..10_100));
    let after = e.frame().unwrap();
    assert_eq!(
        before.row_text(0),
        after.row_text(0),
        "viewport did not move"
    );
    e.set_follow(true);
    let f = e.frame().unwrap();
    assert_eq!(f.row_text(8), "line 10099");
}

#[test]
fn the_search_counts_new_output_once_it_is_refreshed() {
    let mut e = emu(40, 6, true);
    e.feed(b"needle one\n");
    assert_eq!(e.search(Some("needle")).total, 1);
    e.feed(b"needle two\nneedle three\n");
    // Feeding the terminal does not run the search: this is why a count
    // read with `search_state` alone is one batch of output behind.
    assert_eq!(e.search_state().total, 1, "not run since the output");
    let refreshed = e.search_refresh();
    assert_eq!(refreshed.total, 3);
    // The frame's highlights come from the same pass and agree.
    assert_eq!(e.frame().unwrap().matches.len(), 3);
    assert_eq!(e.search_state(), refreshed);
    // With no search there is nothing to refresh.
    e.search(None);
    assert_eq!(e.search_refresh().total, 0);
}

/// Ask for the count and then the frame, as a redraw does, after one
/// change: both come from one search pass, exactly one.
fn one_pass(e: &mut Emulator, what: &str, runs: &mut u64) -> (SearchState, Frame) {
    let count = e.search_refresh();
    let frame = e.frame().unwrap();
    assert_eq!(frame.search, count, "{what}: one state for both");
    assert_eq!(e.search_refresh(), count, "{what}: and it is kept");
    *runs += 1;
    assert_eq!(e.search_runs(), *runs, "{what}: exactly one pass");
    (count, frame)
}

#[test]
fn the_search_runs_once_per_change_and_not_at_all_for_an_unchanged_redraw() {
    let mut e = emu(40, 6, true);
    e.feed(&lines(0..200));
    e.feed(b"needle one\nneedle two\n");
    let found = e.search(Some("needle"));
    assert_eq!(found.total, 2);
    let first = e.frame().unwrap();
    assert_eq!(first.search, found, "the frame carries the same state");

    // Redrawing an unchanged terminal: the count and the highlights are
    // asked for again and again, and the search does no work.
    let settled = e.search_runs();
    for _ in 0..5 {
        assert_eq!(e.search_refresh(), found);
        assert_eq!(e.frame().unwrap(), first);
    }
    assert_eq!(e.search_runs(), settled, "an unchanged redraw runs nothing");
    // Things that change nothing do not count as changes.
    e.feed(b"");
    e.resize(40, 6, 8, 16);
    e.scroll(0);
    let _ = (e.search_refresh(), e.frame().unwrap());
    assert_eq!(e.search_runs(), settled, "no-op calls run nothing");

    // Each change costs one pass, shared by the count and the frame.
    let mut runs = settled;
    e.feed(b"needle three\n");
    let (count, frame) = one_pass(&mut e, "output", &mut runs);
    assert_eq!((count.total, frame.matches.len()), (3, 3));
    e.resize(30, 6, 8, 16);
    assert_eq!(one_pass(&mut e, "resize", &mut runs).0.total, 3);
    // A viewport move: the highlights are for the rows now on screen.
    e.scroll(-100);
    let (count, frame) = one_pass(&mut e, "scroll", &mut runs);
    assert_eq!((count.total, frame.matches.len()), (3, 0));
    e.set_follow(true);
    assert_eq!(one_pass(&mut e, "follow", &mut runs).1.matches.len(), 3);
    // The frame alone, with no count asked for first, also runs it once.
    e.feed(b"needle four\n");
    assert_eq!(e.frame().unwrap().search.total, 4);
    runs += 1;
    assert_eq!(e.search_runs(), runs, "the frame runs the pass itself");
    assert_eq!(e.search_refresh().total, 4);
    assert_eq!(e.search_runs(), runs, "and the count reuses it");

    // Stepping selects among up-to-date matches without a pass of its own
    // here, then the next frame needs one for the new selection.
    let stepped = e.search_step(true);
    assert!(
        stepped.selected.is_some() && stepped.total == 4,
        "{stepped:?}"
    );
    assert_eq!(e.search_runs(), runs, "nothing had changed before the step");
    let (count, frame) = one_pass(&mut e, "step", &mut runs);
    assert_eq!(count, stepped);
    assert_eq!(frame.matches.iter().filter(|m| m.3).count(), 1);
    // Output between frames is seen by the step itself.
    e.feed(b"needle five\n");
    assert_eq!(e.search_step(false).total, 5);

    // A new needle: one pass to search, one for the frame after the
    // viewport moved to the selected match.
    let before = e.search_runs();
    assert_eq!(e.search(Some("line 7")).total, 11);
    let frame = e.frame().unwrap();
    assert_eq!(frame.search.total, 11);
    assert_eq!(e.search_runs(), before + 2);
    // With no search there is nothing to run.
    let before = e.search_runs();
    e.search(None);
    e.feed(b"more\n");
    assert_eq!(e.frame().unwrap().search, Default::default());
    assert_eq!(e.search_runs(), before);
}

#[test]
fn search_counts_matches_in_scrollback_and_scrolls_to_them() {
    let mut e = emu(40, 5, true);
    let mut text = lines(0..2_000);
    text.extend_from_slice(b"needle-one\n");
    text.extend_from_slice(&lines(2_000..2_500));
    text.extend_from_slice(b"needle-two\n");
    text.extend_from_slice(&lines(2_500..2_800));
    text.extend_from_slice(b"needle-three\n");
    text.extend_from_slice(&lines(2_800..3_000));
    e.feed(&text);
    let s = e.search(Some("NEEDLE"));
    assert_eq!(s.total, 3, "case-insensitive for ASCII");
    assert_eq!(s.selected, Some(0), "starts at the newest match");
    let f = e.frame().unwrap();
    assert_eq!(
        f.row_text(0),
        "needle-three",
        "scrolled to the newest match"
    );
    assert_eq!(f.matches, vec![(0, 0, 5, true)]);
    assert!(!e.follow(), "a match above the live end pauses follow");
    assert_eq!(e.search_step(true).selected, Some(1));
    assert_eq!(
        e.frame().unwrap().row_text(0),
        "needle-two",
        "one step older"
    );
    assert_eq!(e.search_step(true).selected, Some(2));
    let f = e.frame().unwrap();
    assert_eq!(f.row_text(0), "needle-one", "oldest");
    assert_eq!(f.matches, vec![(0, 0, 5, true)]);
    assert_eq!(e.search_step(false).selected, Some(1), "back toward newer");
    assert_eq!(e.search(None).total, 0);
    assert!(e.frame().unwrap().matches.is_empty());
}

#[test]
fn selection_and_copy_return_plain_text() {
    let mut e = emu(20, 4, true);
    e.feed(b"\x1b[32mhello\x1b[0m world\nsecond line\n");
    e.select_start(0, 0);
    e.select_to(4, 1);
    let text = e.selection_text().expect("selection");
    assert_eq!(text, "hello world\nsecon");
    let f = e.frame().unwrap();
    assert_eq!(f.selection[0], Some((0, 19)));
    assert_eq!(f.selection[1], Some((0, 4)));
    e.clear_selection();
    assert!(e.selection_text().is_none());
}

#[test]
fn resize_reflows_soft_wrapped_lines() {
    let mut e = emu(10, 6, true);
    e.feed(b"0123456789abcdefghij\nnext\n");
    let f = e.frame().unwrap();
    assert_eq!(f.row_text(0), "0123456789");
    assert_eq!(f.row_text(1), "abcdefghij");
    e.resize(30, 6, 8, 16);
    let f = e.frame().unwrap();
    assert_eq!(f.cols, 30);
    assert_eq!(f.row_text(0), "0123456789abcdefghij", "rewrapped");
    assert_eq!(f.row_text(1), "next");
}

#[test]
fn wide_characters_take_two_cells() {
    let mut e = emu(10, 2, true);
    e.feed("日本\n".as_bytes());
    let f = e.frame().unwrap();
    let r = &f.rows[0];
    assert!(r[0].wide && r[1].spacer && r[2].wide && r[3].spacer);
    assert_eq!(f.row_text(0), "日本");
}

#[test]
fn osc8_hyperlinks_are_readable_and_queries_get_replies() {
    let mut e = emu(40, 2, true);
    e.feed(b"\x1b]8;;https://example.invalid/x\x1b\\link\x1b]8;;\x1b\\ plain\n");
    assert_eq!(
        e.link_at(1, 0).as_deref(),
        Some("https://example.invalid/x")
    );
    assert_eq!(e.link_at(6, 0), None);
    // Device status report: a PTY needs the reply written back.
    let reply = e.feed(b"\x1b[6n");
    assert!(reply.starts_with(b"\x1b["), "{reply:?}");
}

#[test]
fn theme_changes_the_default_colours() {
    use hack_desktop_term::emulator::TermTheme;
    let mut e = emu(10, 3, true);
    e.feed(b"x\n");
    e.set_theme(TermTheme::LIGHT).unwrap();
    let f = e.frame().unwrap();
    assert_eq!(f.background, TermTheme::LIGHT.background);
    assert_eq!(f.rows[0][0].fg, TermTheme::LIGHT.foreground);
    e.feed(b"\x1b[32mg\x1b[0m\n");
    let f = e.frame().unwrap();
    assert_eq!(
        f.rows[1][0].fg,
        TermTheme::LIGHT.ansi[2],
        "themed ANSI palette"
    );
}

#[test]
fn keys_encode_for_the_program_and_follow_its_modes() {
    use hack_desktop_term::emulator::KeyInput;
    let mut e = emu(20, 2, false);
    let k = |key, text| KeyInput {
        key,
        text,
        ..KeyInput::default()
    };
    assert_eq!(e.encode_key(k("a", Some("a"))), b"a");
    assert_eq!(e.encode_key(k("enter", None)), b"\r");
    assert_eq!(e.encode_key(k("backspace", None)), b"\x7f");
    assert_eq!(
        e.encode_key(KeyInput {
            ctrl: true,
            ..k("c", Some("c"))
        }),
        b"\x03"
    );
    assert_eq!(e.encode_key(k("up", None)), b"\x1b[A");
    // DECCKM (application cursor keys), as set by full-screen programs.
    e.feed(b"\x1b[?1h");
    assert_eq!(e.encode_key(k("up", None)), b"\x1bOA");
    assert_eq!(e.encode_key(k("é", Some("é"))), "é".as_bytes());
}

#[test]
fn paste_is_bracketed_when_asked_and_cannot_escape_the_bracket() {
    let mut e = emu(20, 2, false);
    assert_eq!(e.encode_paste("a\nb"), b"a\rb");
    e.feed(b"\x1b[?2004h");
    assert_eq!(
        e.encode_paste("x\x1b[201~rm"),
        b"\x1b[200~x[201~rm\x1b[201~"
    );
}

#[test]
fn the_users_palette_and_cursor_style_apply_until_a_program_overrides_them() {
    use hack_desktop_term::emulator::{CursorShape, KeyInput};
    let mut e = emu(20, 3, true);
    // Index 1 is an ANSI colour, 208 is in the 256-colour cube.
    e.set_palette_entries(&[(1, Rgb::new(250, 1, 2)), (208, Rgb::new(3, 4, 5))])
        .unwrap();
    e.set_default_cursor(Some(CursorShape::Bar)).unwrap();
    e.feed(b"\x1b[31mr\x1b[38;5;208mo\x1b[0m");
    let f = e.frame().unwrap();
    assert_eq!(f.rows[0][0].fg, Rgb::new(250, 1, 2));
    assert_eq!(f.rows[0][1].fg, Rgb::new(3, 4, 5));
    assert_eq!(
        f.cursor_shape,
        Some(CursorShape::Bar),
        "the configured default"
    );
    // A program asks for an underline cursor (DECSCUSR 4), then resets it.
    e.feed(b"\x1b[4 q");
    assert_eq!(
        e.frame().unwrap().cursor_shape,
        Some(CursorShape::Underline)
    );
    e.feed(b"\x1b[0 q");
    assert_eq!(e.frame().unwrap().cursor_shape, Some(CursorShape::Bar));
    // Unrelated: keys still encode.
    assert_eq!(
        e.encode_key(KeyInput {
            key: "a",
            text: Some("a"),
            ..KeyInput::default()
        }),
        b"a"
    );
}
