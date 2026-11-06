//! The build client's output boundary.
//!
//! The client's stderr is a pipe read here, never inherited. Each line is redacted of
//! every build-argument value (the request treats them all as secrets), stripped of
//! terminal control characters and escape sequences, cut at a fixed length, and counted
//! against a fixed budget before it is written to the caller's stream. Redaction is
//! literal: a Dockerfile that transforms a value before printing it (encoding, slicing)
//! is not detected.
use std::{
    io::{Read, Write},
    sync::{Arc, Mutex, mpsc},
    thread::JoinHandle,
    time::Duration,
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
    /// Redact each value and each of its lines, raw and as sanitizing would leave them,
    /// so a value spanning lines or containing control characters is still caught.
    pub(super) fn new<'a>(values: impl IntoIterator<Item = &'a str>) -> Self {
        let mut needles = Vec::new();
        for value in values {
            let parts = std::iter::once(value).chain(value.split(['\n', '\r']));
            for part in parts {
                needles.push(part.as_bytes().to_vec());
                needles.push(sanitize(part.as_bytes()));
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

    /// The bytes to forward for one line (without its terminator). `cut` marks a line
    /// longer than the line bound whose remainder is dropped: a trailing partial match
    /// of any value is removed too, so no prefix of a value survives the cut.
    pub(super) fn line(&mut self, line: &[u8], cut: bool) -> Vec<u8> {
        if self.exhausted {
            return Vec::new();
        }
        let mut raw = line;
        let mut partial = false;
        if cut {
            let tail = self
                .needles
                .iter()
                .filter_map(|needle| {
                    (1..needle.len().min(raw.len() + 1))
                        .rev()
                        .find(|k| raw.ends_with(&needle[..*k]))
                })
                .max()
                .unwrap_or(0);
            raw = &raw[..raw.len() - tail];
            partial = tail > 0;
        }
        let mut out = redact(&sanitize(&redact(raw, &self.needles)), &self.needles);
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

type Sink = Arc<Mutex<Option<Box<dyn Write + Send>>>>;

/// Forwards one pipe through a [`Filter`] on its own thread. Dropping it waits a
/// bounded time for the pipe to close, then closes the sink so no later write lands.
pub(super) struct Forwarder {
    sink: Sink,
    done: mpsc::Receiver<()>,
    thread: Option<JoinHandle<()>>,
}

impl Forwarder {
    pub(super) fn spawn(
        source: impl Read + Send + 'static,
        mut filter: Filter,
        sink: Box<dyn Write + Send>,
    ) -> Self {
        let sink: Sink = Arc::new(Mutex::new(Some(sink)));
        let shared = Arc::clone(&sink);
        let (sender, done) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            filter.pump(source, |bytes| {
                let mut guard = shared.lock().unwrap_or_else(|e| e.into_inner());
                let Some(sink) = guard.as_mut() else {
                    return false;
                };
                // A failing caller stream must not stall the client; keep draining.
                let _ = sink.write_all(bytes).and_then(|()| sink.flush());
                true
            });
            let _ = sender.send(());
        });
        Self {
            sink,
            done,
            thread: Some(thread),
        }
    }
}

impl Drop for Forwarder {
    fn drop(&mut self) {
        let finished = self.done.recv_timeout(DRAIN_WAIT).is_ok();
        self.sink.lock().unwrap_or_else(|e| e.into_inner()).take();
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
