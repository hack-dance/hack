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

use std::time::{Duration, Instant};

use crate::emulator::{Emulator, EmulatorOptions};
use crate::pty::{Pty, PtyOptions, PtySize, WriteOutcome};
use crate::session::ExitInfo;
use crate::stream::{ByteStream, StreamSource};

/// Most bytes fed per pump, so a flood cannot starve input or painting.
pub const MAX_BYTES_PER_PUMP: usize = 1 << 20;
/// After the child exits: how long without output before closing anyway.
pub const EXIT_DRAIN_QUIET: Duration = Duration::from_millis(500);
/// After the child exits: the longest wait for end of output.
pub const EXIT_DRAIN_CAP: Duration = Duration::from_secs(5);

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

pub struct TerminalCore {
    emu: Emulator,
    backend: Backend,
    status: Status,
    notice: Option<String>,
    read_only: bool,
    /// When the child's exit was first seen, and the last output after it.
    exit_seen: Option<(ExitInfo, Instant)>,
    last_output: Instant,
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
        Ok(Self::with(emu, Backend::Stream(stream), true))
    }

    /// An interactive terminal over a program on an app-owned PTY.
    pub fn pty(opts: &PtyOptions) -> std::io::Result<Self> {
        let emu = Emulator::new(EmulatorOptions {
            cols: opts.size.cols,
            rows: opts.size.rows,
            ..EmulatorOptions::default()
        })
        .map_err(std::io::Error::other)?;
        let pty = Pty::spawn(opts)?;
        Ok(Self::with(emu, Backend::Pty(pty), false))
    }

    fn with(emu: Emulator, backend: Backend, read_only: bool) -> Self {
        Self {
            emu,
            backend,
            status: Status::Running,
            notice: None,
            read_only,
            exit_seen: None,
            last_output: Instant::now(),
        }
    }

    pub fn emulator(&mut self) -> &mut Emulator {
        &mut self.emu
    }

    pub fn emu(&self) -> &Emulator {
        &self.emu
    }

    pub fn status(&self) -> &Status {
        &self.status
    }

    /// A message for the user about input that could not be delivered.
    pub fn notice(&self) -> Option<&str> {
        self.notice.as_deref()
    }

    pub fn read_only(&self) -> bool {
        self.read_only
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
                    self.backend = Backend::Closed;
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
                    self.status =
                        Status::Ended(match self.exit_seen.map(|(info, _)| info).or(exit) {
                            Some(info) => format!("process ended ({info})"),
                            None => "terminal closed".into(),
                        });
                    // Dropping the PTY ends whatever is left of the session.
                    self.backend = Backend::Closed;
                    busy = true;
                }
            }
            Backend::Closed => {}
        }
        busy
    }

    /// Queue input for the PTY (no-op for a stream). Input that cannot be
    /// queued is dropped whole and reported through [`Self::notice`].
    pub fn send(&mut self, bytes: &[u8]) {
        let Backend::Pty(pty) = &self.backend else {
            return;
        };
        match pty.write(bytes) {
            WriteOutcome::Queued => self.notice = None,
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

    /// Give up the PTY, for a caller that ends the session itself (app quit).
    pub fn take_pty(&mut self) -> Option<Pty> {
        match std::mem::replace(&mut self.backend, Backend::Closed) {
            Backend::Pty(pty) => Some(pty),
            other => {
                self.backend = other;
                None
            }
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
