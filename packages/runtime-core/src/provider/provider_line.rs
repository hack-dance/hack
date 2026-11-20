//! The provider's own last error line, made safe to show.
//!
//! When a provider command fails, its stderr says why ("machine not found", "no boot progress
//! for 30 seconds"). The runtime's error message that carries stderr is not shown to users,
//! because it can hold anything. This module takes one line of it and removes what must not
//! travel: escape sequences and control characters; the native home, the pool's short home
//! and the temp root it lives under, every shared project root, the user's home; long
//! identifiers; credentials in the shapes they usually take (whatever follows an `=`, unless
//! it is a short number or a fixed word such as `on`; `Bearer ...`; a user and password in a
//! URL); and anything that is not printable ASCII. The result is at most [`MAX`] characters.
//! The CLI validates and redacts the line again before printing it and does not rely on this
//! cleaning.

use crate::{Candidate, CandidateError};
use std::path::Path;

/// The most characters of the provider's line that are carried.
pub const MAX: usize = 200;
/// The longest run of digits a `key=value` token keeps as its value: ports, counts, codes.
const MAX_NUMBER: usize = 10;
/// The only words a `key=value` token keeps as its value.
const PLAIN_WORDS: [&str; 7] = ["on", "off", "true", "false", "yes", "no", "none"];
/// Only this much of the end of the captured stderr is looked at: the reason is the last
/// thing printed. `process::capture` itself keeps the first 64 KiB of stderr, so a reason
/// printed after more output than that is not seen; the provider's commands print far less.
const TAIL: usize = 16 * 1024;
/// A run of hexadecimal digits at least this long is an identifier, not a word.
const MAX_HEX: usize = 12;

/// Removes escape sequences (colours, cursor moves) and every other control character.
fn without_controls(line: &str) -> String {
    let mut plain = String::with_capacity(line.len());
    let mut characters = line.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\u{1b}' {
            match characters.peek() {
                // CSI: parameters and intermediates up to one final byte.
                Some('[') => {
                    characters.next();
                    for next in characters.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&next) {
                            break;
                        }
                    }
                }
                // Any other escape takes one character with it.
                Some(_) => {
                    characters.next();
                }
                None => {}
            }
        } else if !character.is_control() {
            plain.push(character);
        }
    }
    plain
}

/// Whether `character`, straight after a place, ends that place: a separator, the end of a
/// quoted or bracketed path, punctuation that follows a path in a sentence, or white space.
/// Anything else continues a longer name (a sibling called `app+private` or `app2` is not
/// `app`), and a longer name is left as it is.
fn ends_place(character: char) -> bool {
    character == '/'
        || character.is_whitespace()
        || matches!(
            character,
            '"' | '\'' | '`' | ':' | ';' | ',' | ')' | ']' | '}' | '>'
        )
}

/// Replaces `path` by `word` wherever it stands as a whole path prefix.
fn replace_place(text: &str, path: &str, word: &str) -> String {
    let mut replaced = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(found) = rest.find(path) {
        let after = &rest[found + path.len()..];
        replaced.push_str(&rest[..found]);
        if after.chars().next().is_none_or(ends_place) {
            replaced.push_str(word);
        } else {
            replaced.push_str(path);
        }
        rest = after;
    }
    replaced.push_str(rest);
    replaced
}

/// Whether the value of a `key=value` token says nothing private: empty, a short number or
/// one of [`PLAIN_WORDS`]. A short value is not safe by being short (`PASSWORD=hunter2`).
fn plain_value(value: &str) -> bool {
    value.is_empty()
        || (value.len() <= MAX_NUMBER && value.bytes().all(|byte| byte.is_ascii_digit()))
        || PLAIN_WORDS
            .iter()
            .any(|word| value.eq_ignore_ascii_case(word))
}

/// One whitespace-separated token with whatever looks like a credential or an identifier
/// replaced. `after_bearer` says the previous token was `Bearer`.
fn redact(token: &str, after_bearer: bool) -> String {
    if after_bearer {
        return "<value>".into();
    }
    // scheme://user:password@host, before anything is split off: a password may hold `=`.
    let token = match (token.find("://"), token.find('@')) {
        (Some(scheme), Some(at)) if scheme + 3 < at && !token[scheme + 3..at].contains('/') => {
            format!("{}<credentials>{}", &token[..scheme + 3], &token[at..])
        }
        _ => token.to_owned(),
    };
    // Anything after the first `=` (`KEY=value`, `--flag=value`, a URL query) is carried
    // only when it is plainly not a secret. What is before it is cleaned like any token.
    let (token, value) = match token.split_once('=') {
        Some((key, value)) if plain_value(value) => (key, Some(value)),
        Some((key, _)) => (key, Some("<value>")),
        None => (token.as_str(), None),
    };
    // Long runs of hexadecimal digits: machine identifiers and digests.
    let mut plain = String::with_capacity(token.len());
    let mut run = String::new();
    for character in token.chars().chain(std::iter::once(' ')) {
        if character.is_ascii_hexdigit() {
            run.push(character);
            continue;
        }
        if run.len() >= MAX_HEX {
            plain.push_str("<id>");
        } else {
            plain.push_str(&run);
        }
        run.clear();
        plain.push(character);
    }
    plain.pop();
    if let Some(value) = value {
        plain.push('=');
        plain.push_str(value);
    }
    plain
}

/// The last line of `stderr` that still says something once cleaned, or `None`.
/// `places` are host paths and the fixed word shown instead of each.
pub fn clean(stderr: &[u8], places: &[(&Path, &str)]) -> Option<String> {
    let mut places: Vec<(String, &str)> = places
        .iter()
        .filter_map(|(path, word)| {
            let text = path.to_str()?.trim_end_matches('/');
            // A root or a one-letter path would rewrite every path there is.
            (text.len() > 2).then(|| (text.to_owned(), *word))
        })
        .collect();
    // Longest first, so a home inside another place keeps its own word.
    places.sort_by_key(|(path, _)| std::cmp::Reverse(path.len()));
    let tail = String::from_utf8_lossy(&stderr[stderr.len().saturating_sub(TAIL)..]);
    tail.lines().rev().find_map(|line| {
        let mut text = without_controls(line);
        for (path, word) in &places {
            text = replace_place(&text, path, word);
        }
        let mut bearer = false;
        let tokens: Vec<String> = text
            .split_whitespace()
            .map(|token| {
                let redacted = redact(token, bearer);
                bearer = token.eq_ignore_ascii_case("bearer");
                redacted
            })
            .collect();
        let mut text: String = tokens
            .join(" ")
            .chars()
            .map(|character| {
                if (' '..='~').contains(&character) {
                    character
                } else {
                    '?'
                }
            })
            .collect();
        if text.len() > MAX {
            text.truncate(MAX - 3);
            text.push_str("...");
        }
        (!text.is_empty()).then_some(text)
    })
}

/// Adds the provider's cleaned last line, taken from the end of its whole `stderr`, to the
/// error of a failed provider command. `shares` are the project roots this pool mounts.
pub fn attach(
    error: CandidateError,
    stderr: &[u8],
    candidate: &Candidate,
    short_home: &Path,
    shares: &[&Path],
) -> CandidateError {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let temporary = std::env::var_os("TMPDIR").map(std::path::PathBuf::from);
    let mut places: Vec<(&Path, &str)> = vec![
        (candidate.state_root.as_path(), "<native-state>"),
        (candidate.checkout.as_path(), "<native-home>"),
        (short_home, "<pool-home>"),
    ];
    places.extend(shares.iter().map(|share| (*share, "<project>")));
    if let Some(parent) = short_home.parent() {
        places.push((parent, "<tmp>"));
    }
    if let Some(temporary) = &temporary {
        places.push((temporary.as_path(), "<tmp>"));
    }
    if let Some(home) = &home {
        places.push((home.as_path(), "~"));
    }
    match clean(stderr, &places) {
        Some(line) => error.with_provider_line(&line),
        None => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn places() -> Vec<(&'static Path, &'static str)> {
        vec![
            (
                Path::new("/data/person/native/.hack-local"),
                "<native-state>",
            ),
            (Path::new("/data/person/native"), "<native-home>"),
            (Path::new("/private/tmp/hkl-abc123"), "<pool-home>"),
            (Path::new("/private/tmp"), "<tmp>"),
            (Path::new("/data/person"), "~"),
        ]
    }

    #[test]
    fn the_last_line_that_says_something_is_kept() {
        let stderr = "first line\nError: machine not found\n\n   \n";
        assert_eq!(
            clean(stderr.as_bytes(), &places()).as_deref(),
            Some("Error: machine not found")
        );
        assert_eq!(clean(b"", &places()), None);
        assert_eq!(clean(b"\n \n\t\n", &places()), None);
        // A line of nothing but an escape sequence says nothing: the one before it is used.
        assert_eq!(
            clean("real reason\n\u{1b}[0m\n".as_bytes(), &places()).as_deref(),
            Some("real reason")
        );
    }

    #[test]
    fn a_path_inside_a_home_is_shown_by_a_fixed_word() {
        let line = "open /data/person/native/.hack-local/run/smolvm/vm/x.sock: denied; \
                    disk /private/tmp/hkl-abc123/Library/Caches/vm/storage.raw; \
                    tmp /private/tmp/other; config /data/person/.config/tool";
        let cleaned = clean(line.as_bytes(), &places()).unwrap();
        assert_eq!(
            cleaned,
            "open <native-state>/run/smolvm/vm/x.sock: denied; disk \
             <pool-home>/Library/Caches/vm/storage.raw; tmp <tmp>/other; config ~/.config/tool"
        );
        assert!(!cleaned.contains("person"));
        assert!(!cleaned.contains("hkl-abc123"));
        // A place that is the root, or too short to be a home, rewrites nothing.
        assert_eq!(
            clean(
                b"/a/b",
                &[(Path::new("/"), "<root>"), (Path::new("/a"), "<a>")]
            )
            .as_deref(),
            Some("/a/b")
        );
    }

    #[test]
    fn escape_sequences_and_control_characters_are_removed() {
        let line = "\u{1b}[2m2026-11-20T07:18:58Z\u{1b}[0m \u{1b}[32m INFO\u{1b}[0m boot\u{7}: \
                    disks\tready\u{1b}c\r";
        assert_eq!(
            clean(line.as_bytes(), &places()).as_deref(),
            Some("2026-11-20T07:18:58Z INFO boot: disksready")
        );
    }

    #[test]
    fn a_long_line_is_cut_to_the_limit() {
        let cleaned = clean("word ".repeat(100).as_bytes(), &places()).unwrap();
        assert_eq!(cleaned.len(), MAX);
        assert!(cleaned.ends_with("..."));
        let exact = "x".repeat(MAX);
        assert_eq!(
            clean(exact.as_bytes(), &places()).as_deref(),
            Some(exact.as_str())
        );
    }

    #[test]
    fn anything_that_is_not_printable_ascii_becomes_a_question_mark() {
        assert_eq!(
            clean(
                "caf\u{e9} \u{2014} \u{65e5}\u{672c} failed".as_bytes(),
                &places()
            )
            .as_deref(),
            Some("caf? ? ?? failed")
        );
        for line in ["caf\u{e9}", &"\u{65e5}".repeat(300)] {
            let cleaned = clean(line.as_bytes(), &places()).unwrap();
            assert!(cleaned.len() <= MAX);
            assert!(cleaned.bytes().all(|byte| (0x20..=0x7e).contains(&byte)));
        }
    }

    #[test]
    fn a_value_after_an_equals_sign_is_carried_only_as_a_number_or_a_fixed_word() {
        // Short is not safe: a short secret-shaped value goes like a long one.
        let line = "start failed PASSWORD=hunter2 TOKEN=ab12cd34ef --password=hunter2 \
                    REGION_NAME=sixteen-chars-xx path=/some/where a=b==c =orphan";
        assert_eq!(
            clean(line.as_bytes(), &places()).as_deref(),
            Some(
                "start failed PASSWORD=<value> TOKEN=<value> --password=<value> \
                 REGION_NAME=<value> path=<value> a=<value> =<value>"
            )
        );
        // A short number, a fixed word and an empty value stay.
        assert_eq!(
            clean(
                b"port=8080 code=13 debug=TRUE mode=off retry=no left= pin=12345678901 on=maybe",
                &places()
            )
            .as_deref(),
            Some("port=8080 code=13 debug=TRUE mode=off retry=no left= pin=<value> on=<value>")
        );
        // What is before the `=` is still cleaned: credentials in a URL, a long identifier.
        assert_eq!(
            clean(
                b"get https://user:hun=ter2@registry.example/v2?scope=pull vm-cf86560b70f1f4c9abcd=7",
                &places()
            )
            .as_deref(),
            Some("get https://<credentials>@registry.example/v2?scope=<value> vm-<id>=7")
        );
    }

    #[test]
    fn a_shared_project_outside_the_home_and_a_look_alike_path_are_handled() {
        let mut places = places();
        places.push((Path::new("/Volumes/client-disk/app"), "<project>"));
        let line = "virtiofs: cannot share /Volumes/client-disk/app/src: gone; \
                    other /Volumes/client-disk/app-two/x /Volumes/client-disk/app+b/y \
                    /Volumes/client-disk/app2 and /data/person-else/y";
        assert_eq!(
            clean(line.as_bytes(), &places).as_deref(),
            Some(
                "virtiofs: cannot share <project>/src: gone; other /Volumes/client-disk/app-two/x \
                 /Volumes/client-disk/app+b/y /Volumes/client-disk/app2 and /data/person-else/y"
            )
        );
        // A place at the end of the text, before a quote or a colon, is a whole place.
        assert_eq!(
            clean(
                b"at \"/data/person\": no; in /private/tmp: no; /data/person",
                &places
            )
            .as_deref(),
            Some("at \"~\": no; in <tmp>: no; ~")
        );
    }

    #[test]
    fn identifiers_and_credentials_in_their_usual_shapes_are_never_carried() {
        let line = "vm cf86560b70f1f4c9 at vms/cf86560b70f1f4c9abcd/x.sock sha256:\
                    0123456789abcdef0123456789abcdef pull https://user:hunter2@registry.example/v2 \
                    Authorization: Bearer abc.def-ghi short deadbeef";
        assert_eq!(
            clean(line.as_bytes(), &places()).as_deref(),
            Some(
                "vm <id> at vms/<id>/x.sock sha256:<id> pull \
                 https://<credentials>@registry.example/v2 Authorization: Bearer <value> short \
                 deadbeef"
            )
        );
        // An ordinary URL and an address with an at sign are left alone.
        assert_eq!(
            clean(
                b"get https://registry.example/v2/a@sha failed for a@b",
                &places()
            )
            .as_deref(),
            Some("get https://registry.example/v2/a@sha failed for a@b")
        );
    }

    #[test]
    fn the_reason_is_found_at_the_end_of_a_long_stderr() {
        // Far more warnings than any prefix limit, then the reason.
        let mut stderr = "warning: something minor happened here\n"
            .repeat(2_000)
            .into_bytes();
        stderr.extend_from_slice(b"Error: machine not found\n");
        assert!(stderr.len() > 4 * TAIL);
        assert_eq!(
            clean(&stderr, &places()).as_deref(),
            Some("Error: machine not found")
        );
        // A last line longer than the tail that is looked at is still one bounded line.
        let mut stderr = b"first\n".to_vec();
        stderr.extend(std::iter::repeat_n(b'x', 3 * TAIL));
        let cleaned = clean(&stderr, &places()).unwrap();
        assert_eq!(cleaned.len(), MAX);
    }

    #[test]
    fn the_line_comes_from_the_whole_stderr_of_a_real_failed_command() {
        let candidate = Candidate::discover(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        let output = super::super::process::capture(
            std::process::Command::new("/bin/sh").args([
                "-c",
                "i=0; while [ $i -lt 400 ]; do echo 'warning: filler filler filler filler' >&2; \
                 i=$((i+1)); done; printf '\\033[31mError: cannot share /Volumes/x/app\\033[0m\\n' >&2; exit 3",
            ]),
            std::time::Duration::from_secs(20),
        )
        .unwrap();
        assert!(!output.status.success());
        assert!(output.stderr.len() > 8_192);
        let attached = attach(
            CandidateError::new("provider_command_failed", "exited".to_owned()),
            &output.stderr,
            &candidate,
            Path::new("/private/tmp/hkl-abc123"),
            &[Path::new("/Volumes/x/app")],
        );
        assert_eq!(
            serde_json::to_value(&attached).unwrap()["provider_line"],
            "Error: cannot share <project>"
        );
        // Empty stderr: nothing is attached.
        let attached = attach(
            CandidateError::new("provider_command_failed", "exited".to_owned()),
            b"",
            &candidate,
            Path::new("/private/tmp/hkl-abc123"),
            &[],
        );
        assert!(
            serde_json::to_value(&attached)
                .unwrap()
                .get("provider_line")
                .is_none()
        );
    }
}
