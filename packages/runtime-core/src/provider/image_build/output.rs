//! The build client's output boundary.
//!
//! The client's stderr is a pipe read here, never inherited. Each line is redacted of
//! every build-argument value (defense in depth; arguments are not secrets), stripped of
//! terminal control characters and escape sequences, cut at a fixed length, and counted
//! against a fixed budget before it is written to the caller's stream. Each value is
//! matched raw and in the forms the client prints it in: Go `%q` quoting, JSON string
//! escaping (with and without Go's HTML escaping), and the bake definition's own
//! encoding, which the client quotes in its parse errors. Redaction is otherwise literal:
//! a Dockerfile that transforms a value before printing it (encoding, slicing) is not
//! detected.
use std::{
    io::{Read, Write},
    sync::{
        Arc, Mutex, TryLockError,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

pub(super) const REDACTED: &str = "[redacted]";
const LINE_CUT: &str = " [line truncated]";
const OUTPUT_CUT: &str = "[build output truncated]\n";
/// Longest forwarded line; the rest of a longer line is dropped.
const MAX_LINE_BYTES: usize = 16 * 1024;
/// Total forwarded bytes; later output is drained and dropped.
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// How long forwarding may continue after the client exits (a process outside its group
/// can hold the pipe open). After that, nothing more is written.
const DRAIN_WAIT: Duration = Duration::from_secs(2);
/// How long closing waits for a write already in progress. A caller stream that stops
/// draining must not hold the operation (and its build fence) open.
const CLOSE_WAIT: Duration = Duration::from_secs(1);

/// Line filter: redaction, terminal sanitizing and bounds.
pub(super) struct Filter {
    /// Literal byte strings to redact, longest first.
    needles: Vec<Vec<u8>>,
    forwarded: usize,
    exhausted: bool,
}

/// Keep tabs and printable characters; drop every other control character, which
/// removes the ESC that starts any terminal escape sequence.
fn sanitize(bytes: &[u8]) -> Vec<u8> {
    String::from_utf8_lossy(bytes)
        .chars()
        .filter(|c| *c == '\t' || !c.is_control())
        .collect::<String>()
        .into_bytes()
}

/// The body of Go's `strconv.Quote` (without the surrounding quotes). Printability
/// follows Rust's control and whitespace classes, a close approximation of Go's
/// `unicode.IsPrint`.
fn go_quoted(value: &str) -> String {
    let mut out = String::new();
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{7}' => out.push_str("\\a"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{b}' => out.push_str("\\v"),
            c if (c as u32) < 0x80 && c.is_control() => {
                out.push_str(&format!("\\x{:02x}", c as u32));
            }
            c if c.is_control() || (c.is_whitespace() && c != ' ') => {
                if (c as u32) < 0x10000 {
                    out.push_str(&format!("\\u{:04x}", c as u32));
                } else {
                    out.push_str(&format!("\\U{:08x}", c as u32));
                }
            }
            c => out.push(c),
        }
    }
    out
}

/// The body of a JSON string. `html` adds Go `encoding/json`'s default escaping of
/// `<`, `>`, `&`, U+2028 and U+2029.
fn json_escaped(value: &str, html: bool) -> String {
    let mut out = String::new();
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            '<' | '>' | '&' | '\u{2028}' | '\u{2029}' if html => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

/// Every form of one value the filter redacts.
fn value_forms(value: &str) -> Vec<String> {
    let mut forms = vec![
        value.to_owned(),
        go_quoted(value),
        json_escaped(value, false),
        json_escaped(value, true),
        json_escaped(&super::bake_literal(value), false),
    ];
    // A raw value spanning lines is also caught line by line.
    forms.extend(value.split(['\n', '\r']).map(str::to_owned));
    forms
}

/// The length of the longest suffix of `bytes` that is a proper prefix of a needle.
fn partial_tail(bytes: &[u8], needles: &[Vec<u8>]) -> usize {
    needles
        .iter()
        .filter_map(|needle| {
            (1..needle.len().min(bytes.len() + 1))
                .rev()
                .find(|k| bytes.ends_with(&needle[..*k]))
        })
        .max()
        .unwrap_or(0)
}

fn redact(bytes: &[u8], needles: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    'scan: while at < bytes.len() {
        for needle in needles {
            if bytes[at..].starts_with(needle) {
                out.extend_from_slice(REDACTED.as_bytes());
                at += needle.len();
                continue 'scan;
            }
        }
        out.push(bytes[at]);
        at += 1;
    }
    out
}

impl Filter {
    /// Redact every form of each value (see [`value_forms`]), raw and as sanitizing
    /// would leave it, so a value containing quotes, escapes, control characters or line
    /// breaks is still caught.
    pub(super) fn new<'a>(values: impl IntoIterator<Item = &'a str>) -> Self {
        let mut needles = Vec::new();
        for value in values {
            for form in value_forms(value) {
                needles.push(sanitize(form.as_bytes()));
                needles.push(form.into_bytes());
            }
        }
        needles.retain(|needle| !needle.is_empty());
        needles.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        needles.dedup();
        Self {
            needles,
            forwarded: 0,
            exhausted: false,
        }
    }

    /// The bytes to forward for one line (without its terminator). Values are redacted
    /// in the raw bytes (catching values that contain control characters), the result
    /// is sanitized, and redacted again in the sanitized bytes that are forwarded. `cut`
    /// marks a line longer than the line bound whose remainder is dropped: a trailing
    /// partial match of any value is then trimmed from the sanitized bytes, the ones
    /// actually forwarded, so no prefix of a value survives the cut.
    pub(super) fn line(&mut self, line: &[u8], cut: bool) -> Vec<u8> {
        if self.exhausted {
            return Vec::new();
        }
        let mut clean = sanitize(&redact(line, &self.needles));
        let mut partial = false;
        if cut {
            let tail = partial_tail(&clean, &self.needles);
            clean.truncate(clean.len() - tail);
            partial = tail > 0;
        }
        let mut out = redact(&clean, &self.needles);
        if partial {
            out.extend_from_slice(REDACTED.as_bytes());
        }
        if cut {
            out.extend_from_slice(LINE_CUT.as_bytes());
        }
        out.push(b'\n');
        if self.forwarded + out.len() > MAX_OUTPUT_BYTES {
            self.exhausted = true;
            return OUTPUT_CUT.as_bytes().to_vec();
        }
        self.forwarded += out.len();
        out
    }

    /// Split a byte stream into bounded lines and filter each one.
    fn pump(&mut self, mut source: impl Read, mut emit: impl FnMut(&[u8]) -> bool) {
        let mut line = Vec::new();
        let mut skipping = false;
        let mut chunk = [0_u8; 8192];
        loop {
            let size = match source.read(&mut chunk) {
                Ok(0) => break,
                Ok(size) => size,
                // The cancellation handlers are installed without SA_RESTART.
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            for &byte in &chunk[..size] {
                if byte == b'\n' {
                    if !skipping && !emit(&self.line(&line, false)) {
                        return;
                    }
                    line.clear();
                    skipping = false;
                } else if !skipping {
                    line.push(byte);
                    if line.len() == MAX_LINE_BYTES {
                        if !emit(&self.line(&line, true)) {
                            return;
                        }
                        line.clear();
                        skipping = true;
                    }
                }
            }
        }
        if !line.is_empty() && !skipping {
            emit(&self.line(&line, false));
        }
    }
}

/// Forwards one pipe through a [`Filter`] on its own thread. Dropping it waits a
/// bounded time for the pipe to close, then marks the sink closed. Each write checks
/// that mark while holding the sink lock, and dropping waits (bounded) for that lock,
/// so no write starts after the drop returns. A write already blocked on a caller
/// stream that stopped draining is abandoned after [`CLOSE_WAIT`] rather than awaited.
pub(super) struct Forwarder {
    sink: Arc<Mutex<Box<dyn Write + Send>>>,
    closed: Arc<AtomicBool>,
    done: mpsc::Receiver<()>,
    thread: Option<JoinHandle<()>>,
}

impl Forwarder {
    pub(super) fn spawn(
        source: impl Read + Send + 'static,
        mut filter: Filter,
        sink: Box<dyn Write + Send>,
    ) -> Self {
        let sink = Arc::new(Mutex::new(sink));
        let closed = Arc::new(AtomicBool::new(false));
        let (shared, stop) = (Arc::clone(&sink), Arc::clone(&closed));
        let (sender, done) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            filter.pump(source, |bytes| {
                let mut sink = shared.lock().unwrap_or_else(|e| e.into_inner());
                if stop.load(Ordering::Acquire) {
                    return false;
                }
                // A failing caller stream must not stall the client; keep draining.
                let _ = sink.write_all(bytes).and_then(|()| sink.flush());
                true
            });
            let _ = sender.send(());
        });
        Self {
            sink,
            closed,
            done,
            thread: Some(thread),
        }
    }
}

impl Drop for Forwarder {
    fn drop(&mut self) {
        let finished = self.done.recv_timeout(DRAIN_WAIT).is_ok();
        self.closed.store(true, Ordering::Release);
        // Never block on the lock: a writer stuck on a full caller pipe holds it.
        let deadline = Instant::now() + CLOSE_WAIT;
        while matches!(self.sink.try_lock(), Err(TryLockError::WouldBlock))
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        if let Some(thread) = self.thread.take().filter(|_| finished) {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filtered(values: &[&str], input: &[u8]) -> String {
        let mut filter = Filter::new(values.iter().copied());
        let mut out = Vec::new();
        filter.pump(input, |bytes| {
            out.extend_from_slice(bytes);
            true
        });
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn values_are_redacted_even_across_lines_and_control_characters() {
        let out = filtered(
            &["s3cret", "two\nlines", "es\x1bc"],
            b"#5 s3cret and s3cret\nhead two\nlines tail\nraw es\x1bc and es[c\n",
        );
        assert!(!out.contains("s3cret") && !out.contains("two") && !out.contains("lines"));
        assert_eq!(out.matches(REDACTED).count(), 5, "{out}");
        assert!(!out.contains("esc"), "{out}");
        assert!(!out.contains('\x1b'));
    }

    #[test]
    fn quoted_and_escaped_forms_of_values_are_redacted() {
        let value = "p\"a\\s<s>&\nw\u{1b}d";
        let forms = [
            // Go %q, as buildx prints values in errors.
            "p\\\"a\\\\s<s>&\\nw\\x1bd",
            // JSON, and Go's HTML-escaped JSON.
            "p\\\"a\\\\s<s>&\\nw\\u001bd",
            "p\\\"a\\\\s\\u003cs\\u003e\\u0026\\nw\\u001bd",
        ];
        for form in forms {
            let out = filtered(&[value], format!("err: \"{form}\" done\n").as_bytes());
            assert_eq!(out, format!("err: \"{REDACTED}\" done\n"), "{form}");
        }
        // The bake definition encodes `${`, and the client quotes it in parse errors.
        let out = filtered(&["a${b}c"], b"1 | {\"args\":{\"X\":\"a$${b}c\"}}\n");
        assert_eq!(out, format!("1 | {{\"args\":{{\"X\":\"{REDACTED}\"}}}}\n"));
        assert_eq!(
            go_quoted("\u{2028}\u{1f600}\u{7f}"),
            "\\u2028\u{1f600}\\x7f"
        );
    }

    #[test]
    fn a_value_split_by_a_cut_after_sanitizing_leaves_no_prefix() {
        // Raw bytes end in ESC, so only the sanitized (forwarded) bytes end in a prefix.
        let mut input = vec![b'x'; MAX_LINE_BYTES - 4];
        input.extend_from_slice(b"abc\x1bdefgh tail\n");
        let out = filtered(&["abcdefgh"], &input);
        let first = out.lines().next().unwrap();
        assert!(
            first.ends_with(&format!("x{REDACTED}{LINE_CUT}")),
            "{:?}",
            &first[first.len() - 40..]
        );
        assert!(!out.contains("abc"));
    }

    #[test]
    fn terminal_control_sequences_are_stripped_and_tabs_kept() {
        let out = filtered(
            &[],
            b"\x1b[2J\x1b]0;title\x07ok\tdone\r\n\x00\x7f\xc2\x9bend",
        );
        assert_eq!(out, "[2J]0;titleok\tdone\nend\n");
        assert!(
            out.bytes()
                .all(|b| b == b'\t' || b == b'\n' || !b.is_ascii_control())
        );
    }

    #[test]
    fn long_lines_are_cut_without_leaving_a_value_prefix() {
        let secret = "abcdefgh";
        let mut input = vec![b'x'; MAX_LINE_BYTES - 3];
        input.extend_from_slice(b"abcdefgh-rest-of-line\nnext\n");
        let out = filtered(&[secret], &input);
        let first = out.lines().next().unwrap();
        assert!(
            first.ends_with(&format!("{REDACTED}{LINE_CUT}")),
            "{first:?}"
        );
        assert!(!first.contains("abc"));
        assert!(!out.contains("rest-of-line"));
        assert!(out.ends_with("next\n"));
    }

    #[test]
    fn output_beyond_the_budget_is_dropped_with_one_notice() {
        let line = vec![b'y'; 1023];
        let mut input = Vec::new();
        for _ in 0..(MAX_OUTPUT_BYTES / 1024 + 10) {
            input.extend_from_slice(&line);
            input.push(b'\n');
        }
        let out = filtered(&[], &input);
        assert!(out.len() <= MAX_OUTPUT_BYTES + OUTPUT_CUT.len());
        assert!(out.ends_with(OUTPUT_CUT));
        assert_eq!(out.matches(OUTPUT_CUT).count(), 1);
    }

    #[test]
    fn a_caller_stream_that_stops_draining_cannot_hold_shutdown() {
        let (release, blocked) = mpsc::channel::<()>();
        let writes = Arc::new(Mutex::new(0_usize));
        struct Stuck(mpsc::Receiver<()>, Arc<Mutex<usize>>);
        impl Write for Stuck {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                *self.1.lock().unwrap() += 1;
                // Like a full pipe whose reader stopped consuming.
                let _ = self.0.recv();
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (reader, writer) = std::os::unix::net::UnixStream::pair().unwrap();
        let forwarder = Forwarder::spawn(
            reader,
            Filter::new([]),
            Box::new(Stuck(blocked, Arc::clone(&writes))),
        );
        (&writer).write_all(b"one\n").unwrap();
        let started = Instant::now();
        while *writes.lock().unwrap() == 0 {
            assert!(started.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(5));
        }
        (&writer).write_all(b"two\n").unwrap();
        let started = Instant::now();
        drop(forwarder);
        let elapsed = started.elapsed();
        assert!(
            elapsed < DRAIN_WAIT + CLOSE_WAIT + Duration::from_secs(2),
            "shutdown waited {elapsed:?} on a blocked writer"
        );
        // The blocked write completes later; no further line is written after close.
        release.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(*writes.lock().unwrap(), 1);
    }

    #[test]
    fn a_held_pipe_does_not_outlive_the_forwarder() {
        let (reader, writer) = std::os::unix::net::UnixStream::pair().unwrap();
        let captured = Arc::new(Mutex::new(Vec::new()));
        struct Shared(Arc<Mutex<Vec<u8>>>);
        impl Write for Shared {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let forwarder = Forwarder::spawn(
            reader,
            Filter::new(["v"]),
            Box::new(Shared(Arc::clone(&captured))),
        );
        (&writer).write_all(b"before v\n").unwrap();
        let started = std::time::Instant::now();
        while captured.lock().unwrap().is_empty() {
            assert!(started.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(5));
        }
        drop(forwarder);
        (&writer).write_all(b"after\n").unwrap();
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(&*captured.lock().unwrap(), b"before [redacted]\n");
    }
}
