//! An emulator joined to its byte source: a read-only stream or an
//! app-owned PTY. This is the part of the terminal view that has no GUI in
//! it, so it can be driven and tested without a window.
//!
//! [`TerminalCore::pump`] moves pending output into the emulator. It never
//! blocks: output comes from a bounded queue and input goes to one.
//!
//! End of a PTY session is decided by the end of its **output**, not by the
//! child's exit. A child can exit with output still in flight; pumping
//! continues until the terminal reports end of file. If the child has
//! exited but something else still holds the terminal open (a background
//! job), the core waits [`EXIT_DRAIN_QUIET`] without new output, at most
//! [`EXIT_DRAIN_CAP`], then takes what has arrived and closes.
//!
//! A session started from a [`SessionPlan`] with several attempts (a
//! container shell: `bash`, then `sh`) moves to the next attempt when the
//! current one could not start its program: it ended with exit status 126
//! or 127 within [`FALLBACK_WINDOW`], before the user typed anything.
//!
//! While another attempt is still possible, input is held until the
//! current attempt has settled: it produced output and stayed running for
//! [`SETTLE_AFTER_OUTPUT`], or ran for the whole [`FALLBACK_WINDOW`] (a
//! shell that prints no prompt). Input is also held once the attempt has
//! exited, until the session falls back or ends. Input therefore only ever
//! reaches one attempt: held input goes to the attempt that settles, `sh`
//! after a missing `bash` included, and counts as typed from then on.
//! However slow `docker exec` is to fail, typing while the tab opens never
//! cancels the fallback, and nothing typed runs twice.
//!
//! An attempt that prints and then stays running for longer than
//! [`SETTLE_AFTER_OUTPUT`] counts as started: input from then on is the
//! user's, and a later 126 or 127 ends the session (a started shell running
//! `exit 127` looks the same). A single-attempt session never holds input.

use std::time::{Duration, Instant};

use crate::emulator::{Emulator, EmulatorOptions};
use crate::launch::{Launch, SessionKind, SessionPlan};
use crate::pty::{Pty, PtyOptions, PtySize, WriteOutcome};
use crate::session::{ExitInfo, PendingTeardown, Teardown};
use crate::stream::{ByteStream, StreamSource};

/// Most bytes fed per pump, so a flood cannot starve input or painting.
pub const MAX_BYTES_PER_PUMP: usize = 1 << 20;
/// After the child exits: how long without output before closing anyway.
pub const EXIT_DRAIN_QUIET: Duration = Duration::from_millis(500);
/// After the child exits: the longest wait for end of output.
pub const EXIT_DRAIN_CAP: Duration = Duration::from_secs(5);
/// After end of output: the longest wait for the child's exit status to
/// become visible. The terminal can report end of output a moment before
/// the exit can be read; without this wait the session ended as "terminal
/// closed" with no status. Pumping never blocks; this spans pumps.
pub const EOF_EXIT_WAIT: Duration = Duration::from_millis(250);
/// How soon a "command not found" exit must come to try the next attempt.
pub const FALLBACK_WINDOW: Duration = Duration::from_secs(10);
/// With another attempt possible, how long an attempt must keep running
/// after its first output before held input is delivered to it.
pub const SETTLE_AFTER_OUTPUT: Duration = Duration::from_millis(500);

enum Backend {
    Stream(ByteStream),
    Pty(Pty),
    Closed,
}

/// Whether the source is still producing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Status {
    #[default]
    Running,
    Ended(String),
}

/// A session's process side, taken out of the core so the caller can end it
/// (on app quit) and wait for that off the UI thread.
pub enum Shutdown {
    Pty(Pty),
    Stream(ByteStream),
}

impl Shutdown {
    /// End the session on this thread. Blocks up to `deadline`.
    pub fn terminate_blocking_with(self, grace: Duration, deadline: Duration) -> Teardown {
        match self {
            Self::Pty(pty) => pty.terminate_blocking_with(grace, deadline),
            Self::Stream(stream) => stream.terminate_blocking_with(grace, deadline),
        }
    }

    /// End the session on a reaper thread and get a handle to the result.
    pub fn terminate_in_background(self) -> PendingTeardown {
        match self {
            Self::Pty(pty) => pty.terminate_in_background(),
            Self::Stream(stream) => stream.terminate_in_background(),
        }
    }
}

pub struct TerminalCore {
    emu: Emulator,
    backend: Backend,
    kind: SessionKind,
    status: Status,
    notice: Option<String>,
    /// When the child's exit was first seen, and the last output after it.
    exit_seen: Option<(ExitInfo, Instant)>,
    /// When end of output was first seen.
    eof_seen: Option<Instant>,
    last_output: Instant,
    /// Attempts not yet tried, the current start time, and whether the user
    /// has typed: what decides a fallback.
    remaining: Vec<Launch>,
    started: Instant,
    input_sent: bool,
    /// Input typed before the current attempt settled, while another
    /// attempt is still possible. See the module docs.
    held: Vec<u8>,
    /// When the current attempt first produced output.
    first_output: Option<Instant>,
    /// Teardowns of backends this core ended by itself (end of stream,
    /// the session ended, a failed attempt replaced) that have not finished.
    /// Kept so app quit can hurry and await them; see [`Self::take_retired`].
    retired: Vec<PendingTeardown>,
    /// Processes left running by retired teardowns that have finished, not
    /// yet handed out by [`Self::take_retired`].
    retired_survivors: usize,
    /// Every session leader this core started, in order: the first
    /// attempt and each fallback. See [`Self::leaders`].
    leaders: Vec<u32>,
}

/// The notice for input refused whole: larger than the input queue can
/// ever hold, or the queue is full because the program is not reading.
fn dropped_notice(bytes: usize) -> String {
    use crate::pty::INPUT_QUEUE_BYTES;
    if bytes > INPUT_QUEUE_BYTES {
        format!(
            "input not sent: {bytes} bytes is more than the {} MiB input limit",
            INPUT_QUEUE_BYTES >> 20
        )
    } else {
        format!("input not sent: {bytes} bytes (the program is not reading)")
    }
}

/// What [`TerminalCore::take_retired`] hands out: teardowns still running,
/// and how many processes the finished ones left running.
#[derive(Debug, Default)]
pub struct Retired {
    pub pending: Vec<PendingTeardown>,
    pub survivors: usize,
}

impl TerminalCore {
    /// A read-only terminal over a file or process (log stream).
    pub fn stream(source: &StreamSource, scrollback_lines: usize) -> std::io::Result<Self> {
        let stream = ByteStream::open(source)?;
        let emu = Emulator::new(EmulatorOptions {
            scrollback_lines,
            newline_is_crlf: true,
            ..EmulatorOptions::default()
        })
        .map_err(std::io::Error::other)?;
        Ok(Self::with(
            emu,
            Backend::Stream(stream),
            SessionKind::Logs,
            Vec::new(),
        ))
    }

    /// A read-only terminal that shows `text` and has ended, as a file
    /// stream that reached its end does ("end of stream"), with no file
    /// and no process: a note in place of a log stream.
    pub fn note(text: &str, scrollback_lines: usize) -> std::io::Result<Self> {
        let mut emu = Emulator::new(EmulatorOptions {
            scrollback_lines,
            newline_is_crlf: true,
            ..EmulatorOptions::default()
        })
        .map_err(std::io::Error::other)?;
        emu.feed(text.as_bytes());
        let mut core = Self::with(emu, Backend::Closed, SessionKind::Logs, Vec::new());
        core.status = Status::Ended("end of stream".into());
        Ok(core)
    }

    /// An interactive terminal for a session plan: a container shell, a
    /// host shell, or a host shell with env. See [`crate::launch`].
    pub fn session(plan: SessionPlan) -> std::io::Result<Self> {
        let mut attempts = plan.attempts.into_iter();
        let first = attempts
            .next()
            .ok_or_else(|| std::io::Error::other("a session plan needs one attempt"))?;
        let mut options = EmulatorOptions {
            cols: first.options.size.cols,
            rows: first.options.size.rows,
            ..EmulatorOptions::default()
        };
        if matches!(first.kind, SessionKind::Command { .. }) {
            options.scrollback_lines = 2_000;
            options.scrollback_max_bytes = 4 << 20;
        }
        let mut emu = Emulator::new(options).map_err(std::io::Error::other)?;
        if let SessionKind::Command { label, project, .. } = &first.kind {
            let prompt = if *project { "$" } else { "~ $" };
            emu.feed(format!("\x1b[2m{prompt} {label}\x1b[0m\r\n").as_bytes());
        }
        let pty = Pty::spawn(&first.options)?;
        Ok(Self::with(
            emu,
            Backend::Pty(pty),
            first.kind,
            attempts.collect(),
        ))
    }

    /// An interactive terminal over one program on an app-owned PTY, shown
    /// as a host shell named after the program.
    pub fn pty(opts: &PtyOptions) -> std::io::Result<Self> {
        let shell = opts
            .program
            .file_name()
            .map_or_else(|| "sh".into(), |n| n.to_string_lossy().into_owned());
        Self::session(SessionPlan {
            attempts: vec![Launch {
                kind: SessionKind::HostShell { shell },
                options: opts.clone(),
            }],
        })
    }

    fn with(emu: Emulator, backend: Backend, kind: SessionKind, remaining: Vec<Launch>) -> Self {
        let leaders = match &backend {
            Backend::Pty(pty) => vec![pty.pid()],
            Backend::Stream(stream) => stream.pid().into_iter().collect(),
            Backend::Closed => Vec::new(),
        };
        Self {
            emu,
            backend,
            kind,
            status: Status::Running,
            notice: None,
            exit_seen: None,
            eof_seen: None,
            last_output: Instant::now(),
            remaining,
            started: Instant::now(),
            input_sent: false,
            held: Vec::new(),
            first_output: None,
            retired: Vec::new(),
            retired_survivors: 0,
            leaders,
        }
    }

    /// Drop finished retired teardowns, keeping the count of what each
    /// left running so it can still be reported.
    fn prune_retired(&mut self) {
        let mut survivors = 0;
        self.retired.retain(|pending| match pending.try_result() {
            Some(done) => {
                survivors += done.survivors.len();
                false
            }
            None => true,
        });
        self.retired_survivors += survivors;
    }

    /// End a backend this core no longer uses on a reaper thread, and keep
    /// the handle until it finishes.
    fn retire(&mut self, backend: Backend) {
        self.prune_retired();
        let shutdown = match backend {
            Backend::Pty(pty) => Shutdown::Pty(pty),
            Backend::Stream(stream) => Shutdown::Stream(stream),
            Backend::Closed => return,
        };
        self.retired.push(shutdown.terminate_in_background());
    }

    /// Give up the teardowns of backends this core ended by itself that
    /// are still running, so the caller can hurry and await them (app
    /// quit) or keep them after the view is gone (closing a tab), with the
    /// number of processes the finished ones left running, to report.
    pub fn take_retired(&mut self) -> Retired {
        self.prune_retired();
        Retired {
            pending: std::mem::take(&mut self.retired),
            survivors: std::mem::take(&mut self.retired_survivors),
        }
    }

    pub fn emulator(&mut self) -> &mut Emulator {
        &mut self.emu
    }

    pub fn emu(&self) -> &Emulator {
        &self.emu
    }

    /// What this tab is: its label and badge come from here. A container
    /// shell's kind changes if `bash` was missing and `sh` was started.
    pub fn kind(&self) -> &SessionKind {
        &self.kind
    }

    /// Every session leader this core has started, the first attempt and
    /// each fallback, whether or not it is still running. Each is also its
    /// session's id, so a caller can account for what those sessions left.
    pub fn leaders(&self) -> &[u32] {
        &self.leaders
    }

    /// The running session's leader pid, which is also its session id.
    /// `None` for a file-backed stream or once the backend has closed. A
    /// container shell that fell back from `bash` to `sh` has a new leader.
    pub fn leader(&self) -> Option<u32> {
        match &self.backend {
            Backend::Pty(pty) => Some(pty.pid()),
            Backend::Stream(stream) => stream.pid(),
            Backend::Closed => None,
        }
    }

    pub fn status(&self) -> &Status {
        &self.status
    }

    /// Exit information is final only after the last attempt's output drains.
    pub fn exit_status(&self) -> Option<ExitInfo> {
        if matches!(self.status, Status::Ended(_)) {
            self.exit_seen.map(|(info, _)| info)
        } else {
            None
        }
    }

    /// Password entry is a property of the current PTY. Only the terminal
    /// reads the mode and looks for a prompt. No input is inspected.
    pub fn waiting_for_password(&mut self) -> bool {
        if !matches!(
            self.kind,
            SessionKind::Command {
                expects_password: true,
                ..
            }
        ) || !matches!(&self.backend, Backend::Pty(pty) if pty.echo_disabled())
        {
            return false;
        }
        let Ok(frame) = self.emu.frame() else {
            return false;
        };
        frame.cursor.is_some_and(|(_, row)| {
            let line = frame.row_text(usize::from(row)).to_ascii_lowercase();
            line.ends_with(':') && line.contains("password")
        })
    }

    /// A message for the user about input that could not be delivered.
    pub fn notice(&self) -> Option<&str> {
        self.notice.as_deref()
    }

    pub fn read_only(&self) -> bool {
        !self.kind.is_interactive()
    }

    /// Move pending output into the emulator. Returns whether anything
    /// changed. Never blocks.
    pub fn pump(&mut self) -> bool {
        let mut busy = false;
        match &mut self.backend {
            Backend::Stream(s) => {
                let (bytes, end) = s.drain(MAX_BYTES_PER_PUMP);
                if !bytes.is_empty() {
                    self.emu.feed(&bytes);
                    busy = true;
                }
                if let Some(end) = end {
                    self.status = Status::Ended(match end {
                        Ok(()) => "end of stream".into(),
                        Err(e) => format!("read failed: {e}"),
                    });
                    // The output ended; the process may still be running.
                    let ended = std::mem::replace(&mut self.backend, Backend::Closed);
                    self.retire(ended);
                    busy = true;
                }
            }
            Backend::Pty(pty) => {
                let read = pty.read(MAX_BYTES_PER_PUMP);
                if !read.bytes.is_empty() {
                    busy = true;
                    self.last_output = Instant::now();
                    self.first_output.get_or_insert(self.last_output);
                    let reply = self.emu.feed(&read.bytes);
                    // Query replies are a few bytes; if the child is not
                    // reading there is nobody waiting for them.
                    let _ = pty.write(&reply);
                }
                let exit = pty.exit();
                if let (Some(info), None) = (exit, self.exit_seen) {
                    self.exit_seen = Some((info, Instant::now()));
                }
                // `last_output` was just refreshed if this pump read anything,
                // so "quiet" is only true once the queue has stayed empty.
                let (quiet, capped) = self.exit_seen.map_or((false, false), |(_, at)| {
                    (
                        at.max(self.last_output).elapsed() >= EXIT_DRAIN_QUIET,
                        at.elapsed() >= EXIT_DRAIN_CAP,
                    )
                });
                if read.eof && self.eof_seen.is_none() {
                    self.eof_seen = Some(Instant::now());
                }
                // End of output ends the session once the exit status is
                // known, or after EOF_EXIT_WAIT without it.
                let eof_done = self
                    .eof_seen
                    .is_some_and(|at| self.exit_seen.is_some() || at.elapsed() >= EOF_EXIT_WAIT);
                if eof_done || quiet || capped {
                    let info = self.exit_seen.map(|(info, _)| info).or(exit);
                    busy = true;
                    if !self.try_next_attempt(info) {
                        self.status = Status::Ended(match info {
                            Some(info) => format!("process ended ({info})"),
                            None => "terminal closed".into(),
                        });
                        if matches!(self.kind, SessionKind::Command { .. }) {
                            let result = match info {
                                Some(ExitInfo::Exited(code)) => format!("exit {code}"),
                                Some(ExitInfo::Signaled(signal)) => format!("signal {signal}"),
                                _ => "exit status unavailable".into(),
                            };
                            self.emu.feed(
                                format!(
                                    "\r\n\x1b[2m{result} · {:.1} s\x1b[0m\x1b[?25l\r\n",
                                    self.started.elapsed().as_secs_f32()
                                )
                                .as_bytes(),
                            );
                        }
                        // End whatever is left of the session.
                        let ended = std::mem::replace(&mut self.backend, Backend::Closed);
                        self.retire(ended);
                    }
                } else if !self.held.is_empty() && self.settled() {
                    let held = std::mem::take(&mut self.held);
                    // Input accepted earlier: a notice set since then (a
                    // refused paste) stays up.
                    self.deliver(&held, false);
                    busy = true;
                }
            }
            Backend::Closed => {}
        }
        busy
    }

    /// Whether input goes straight to the current attempt: no other
    /// attempt is left, or this one has settled (module docs).
    fn settled(&self) -> bool {
        self.remaining.is_empty()
            || (!self.exited()
                && (self.showed_itself() || self.started.elapsed() >= FALLBACK_WINDOW))
    }

    /// The current attempt printed something and stayed running for
    /// [`SETTLE_AFTER_OUTPUT`]: input delivered now counts as typed.
    fn showed_itself(&self) -> bool {
        self.first_output
            .is_some_and(|t| t.elapsed() >= SETTLE_AFTER_OUTPUT)
    }

    /// The current attempt's child has exited, whether or not a pump has
    /// seen it yet. Input must not go to it then: a fallback may follow.
    fn exited(&self) -> bool {
        self.exit_seen.is_some()
            || match &self.backend {
                Backend::Pty(pty) => pty.exit().is_some(),
                _ => false,
            }
    }

    /// Start the next attempt of the plan if the current one could not
    /// start its program. Returns whether a new attempt is now running.
    fn try_next_attempt(&mut self, exit: Option<ExitInfo>) -> bool {
        let could_not_start = matches!(exit, Some(ExitInfo::Exited(126 | 127)))
            && !self.input_sent
            && self.started.elapsed() < FALLBACK_WINDOW;
        if !could_not_start || self.remaining.is_empty() {
            return false;
        }
        let next = self.remaining.remove(0);
        let mut options = next.options;
        options.size = PtySize::cells(self.emu.cols(), self.emu.rows());
        match Pty::spawn(&options) {
            Ok(pty) => {
                self.leaders.push(pty.pid());
                // A full reset: the failed attempt's error text is not part
                // of the session the user asked for.
                self.emu.feed(b"\x1bc");
                let failed = std::mem::replace(&mut self.backend, Backend::Pty(pty));
                self.retire(failed);
                self.kind = next.kind;
                self.exit_seen = None;
                self.eof_seen = None;
                self.last_output = Instant::now();
                self.started = Instant::now();
                self.first_output = None;
                true
            }
            Err(_) => false,
        }
    }

    /// Queue input for the PTY (no-op for a stream). Input that cannot be
    /// queued is dropped whole and reported through [`Self::notice`].
    pub fn send(&mut self, bytes: &[u8]) {
        if !matches!(self.backend, Backend::Pty(_)) || bytes.is_empty() {
            return;
        }
        if !self.settled() || !self.held.is_empty() {
            // Keep order: anything typed after held input waits with it.
            if self.held.len() + bytes.len() > crate::pty::INPUT_QUEUE_BYTES {
                self.notice = Some(dropped_notice(bytes.len()));
            } else {
                self.held.extend_from_slice(bytes);
                self.notice = None;
            }
            return;
        }
        self.deliver(bytes, true);
    }

    /// Write input to the current attempt; it now counts as typed. `fresh`:
    /// input the user just gave, which replaces any notice; held input
    /// delivered later leaves the notice as it is.
    fn deliver(&mut self, bytes: &[u8], fresh: bool) {
        let Backend::Pty(pty) = &self.backend else {
            return;
        };
        match pty.write(bytes) {
            WriteOutcome::Queued => {
                if fresh {
                    self.notice = None;
                }
                self.input_sent = true;
            }
            WriteOutcome::Dropped { bytes } => {
                self.notice = Some(dropped_notice(bytes));
            }
            WriteOutcome::Closed => {}
        }
    }

    /// Resize the grid and tell the PTY.
    pub fn resize(&mut self, cols: u16, rows: u16, cell_w_px: u16, cell_h_px: u16) {
        if cols == self.emu.cols() && rows == self.emu.rows() {
            return;
        }
        self.emu
            .resize(cols, rows, u32::from(cell_w_px), u32::from(cell_h_px));
        if let Backend::Pty(pty) = &self.backend {
            let _ = pty.resize(PtySize {
                cols,
                rows,
                pixel_width: cols.saturating_mul(cell_w_px),
                pixel_height: rows.saturating_mul(cell_h_px),
            });
        }
    }

    /// Give up the process side, for a caller that ends the session itself
    /// and wants the result (app quit, or closing a tab and reporting
    /// survivors). `None` for a file stream's core once it has ended, or
    /// when already taken.
    pub fn take_shutdown(&mut self) -> Option<Shutdown> {
        match std::mem::replace(&mut self.backend, Backend::Closed) {
            Backend::Pty(pty) => Some(Shutdown::Pty(pty)),
            Backend::Stream(stream) => Some(Shutdown::Stream(stream)),
            Backend::Closed => None,
        }
    }

    /// Pump until the source ends, nothing arrives for `quiet`, or
    /// `deadline` passes. For headless capture and tests.
    pub fn settle(&mut self, quiet: Duration, deadline: Duration) {
        let start = Instant::now();
        let mut last = Instant::now();
        while start.elapsed() < deadline && last.elapsed() < quiet && self.status == Status::Running
        {
            if self.pump() {
                last = Instant::now();
            } else {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_note_shows_its_text_has_ended_and_has_no_process() {
        let mut core = TerminalCore::note("first line\nsecond line\n", 100).expect("note");
        assert_eq!(*core.status(), Status::Ended("end of stream".into()));
        assert!(core.read_only());
        assert_eq!(core.leader(), None);
        assert!(core.leaders().is_empty());
        let frame = core.emulator().frame().expect("frame");
        let text: Vec<String> = (0..2).map(|r| frame.row_text(r)).collect();
        assert_eq!(text[0].trim_end(), "first line");
        assert_eq!(
            text[1].trim_end(),
            "second line",
            "a bare newline starts a new line"
        );
    }

    #[test]
    fn a_paste_larger_than_the_input_queue_names_the_limit() {
        use crate::pty::INPUT_QUEUE_BYTES;
        let over = dropped_notice(INPUT_QUEUE_BYTES + 1);
        assert!(over.contains("more than the 1 MiB input limit"), "{over}");
        let full = dropped_notice(INPUT_QUEUE_BYTES);
        assert!(full.contains("the program is not reading"), "{full}");
    }
    use crate::session::Hurry;

    fn finished(survivors: Vec<libc::pid_t>) -> PendingTeardown {
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(Teardown {
            gone: survivors.is_empty(),
            escalated: false,
            survivors,
        })
        .expect("send");
        PendingTeardown::new(rx, Hurry::new(Duration::ZERO))
    }

    #[test]
    fn finished_retired_teardowns_still_report_what_they_left_running() {
        let home = crate::testutil::TempHome::new();
        let empty = home.path().join("empty.log");
        std::fs::write(&empty, b"").unwrap();
        let mut core = TerminalCore::stream(&StreamSource::File(empty), 10).expect("core");
        let (_tx, rx) = std::sync::mpsc::channel();
        let running = PendingTeardown::new(rx, Hurry::new(Duration::ZERO));
        core.retired = vec![finished(vec![101, 102]), finished(Vec::new()), running];
        // Pruning on the way (another backend retired) must not lose them.
        core.prune_retired();
        core.retired.push(finished(vec![103]));

        let taken = core.take_retired();
        assert_eq!(taken.survivors, 3, "every survivor of a finished teardown");
        assert_eq!(taken.pending.len(), 1, "only the unfinished one is pending");
        let again = core.take_retired();
        assert_eq!(
            (again.survivors, again.pending.len()),
            (0, 0),
            "handed out once"
        );
    }
}
