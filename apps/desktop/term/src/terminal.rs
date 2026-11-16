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
/// How soon a "command not found" exit must come to try the next attempt.
pub const FALLBACK_WINDOW: Duration = Duration::from_secs(10);

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
    last_output: Instant,
    /// Attempts not yet tried, the current start time, and whether the user
    /// has typed: what decides a fallback.
    remaining: Vec<Launch>,
    started: Instant,
    input_sent: bool,
    /// Teardowns of backends this core ended by itself (end of stream,
    /// the session ended, a failed attempt replaced) that have not finished.
    /// Kept so app quit can hurry and await them; see [`Self::take_retired`].
    retired: Vec<PendingTeardown>,
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

    /// An interactive terminal for a session plan: a container shell, a
    /// host shell, or a host shell with env. See [`crate::launch`].
    pub fn session(plan: SessionPlan) -> std::io::Result<Self> {
        let mut attempts = plan.attempts.into_iter();
        let first = attempts
            .next()
            .ok_or_else(|| std::io::Error::other("a session plan needs one attempt"))?;
        let emu = Emulator::new(EmulatorOptions {
            cols: first.options.size.cols,
            rows: first.options.size.rows,
            ..EmulatorOptions::default()
        })
        .map_err(std::io::Error::other)?;
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
        Self {
            emu,
            backend,
            kind,
            status: Status::Running,
            notice: None,
            exit_seen: None,
            last_output: Instant::now(),
            remaining,
            started: Instant::now(),
            input_sent: false,
            retired: Vec::new(),
        }
    }

    /// End a backend this core no longer uses on a reaper thread, and keep
    /// the handle until it finishes.
    fn retire(&mut self, backend: Backend) {
        self.retired
            .retain(|pending| pending.try_result().is_none());
        let shutdown = match backend {
            Backend::Pty(pty) => Shutdown::Pty(pty),
            Backend::Stream(stream) => Shutdown::Stream(stream),
            Backend::Closed => return,
        };
        self.retired.push(shutdown.terminate_in_background());
    }

    /// Give up the teardowns of backends this core ended by itself that
    /// are still running, so the caller can hurry and await them (app
    /// quit) or keep them after the view is gone (closing a tab).
    pub fn take_retired(&mut self) -> Vec<PendingTeardown> {
        self.retired
            .retain(|pending| pending.try_result().is_none());
        std::mem::take(&mut self.retired)
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

    pub fn status(&self) -> &Status {
        &self.status
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
                if read.eof || quiet || capped {
                    let info = self.exit_seen.map(|(info, _)| info).or(exit);
                    busy = true;
                    if !self.try_next_attempt(info) {
                        self.status = Status::Ended(match info {
                            Some(info) => format!("process ended ({info})"),
                            None => "terminal closed".into(),
                        });
                        // End whatever is left of the session.
                        let ended = std::mem::replace(&mut self.backend, Backend::Closed);
                        self.retire(ended);
                    }
                }
            }
            Backend::Closed => {}
        }
        busy
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
                // A full reset: the failed attempt's error text is not part
                // of the session the user asked for.
                self.emu.feed(b"\x1bc");
                let failed = std::mem::replace(&mut self.backend, Backend::Pty(pty));
                self.retire(failed);
                self.kind = next.kind;
                self.exit_seen = None;
                self.last_output = Instant::now();
                self.started = Instant::now();
                true
            }
            Err(_) => false,
        }
    }

    /// Queue input for the PTY (no-op for a stream). Input that cannot be
    /// queued is dropped whole and reported through [`Self::notice`].
    pub fn send(&mut self, bytes: &[u8]) {
        let Backend::Pty(pty) = &self.backend else {
            return;
        };
        if bytes.is_empty() {
            return;
        }
        match pty.write(bytes) {
            WriteOutcome::Queued => {
                self.notice = None;
                self.input_sent = true;
            }
            WriteOutcome::Dropped { bytes } => {
                self.notice = Some(format!(
                    "input not sent: {bytes} bytes (the program is not reading)"
                ));
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
