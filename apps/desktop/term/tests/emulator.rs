//! libghostty-vt behaviour the terminal surface relies on, read back
//! through the same `Frame` the GPUI element paints.
#![cfg(all(unix, feature = "ghostty"))]

use hack_desktop_term::emulator::{Emulator, EmulatorOptions, Rgb};

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
