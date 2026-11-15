//! Read-only byte sources for the terminal surface: a file or a process.
//!
//! A process source runs in its own process group with stdin closed and
//! stdout and stderr merged into one pipe, in the order the process wrote
//! them. Dropping the [`ByteStream`] signals the group (SIGTERM, then
//! SIGKILL after [`crate::pty::TERMINATE_GRACE`]) and reaps the child on a
//! background thread; it never blocks the caller.
//!
//! Bytes are passed through as printed. Nothing here logs them.

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::{Duration, Instant};

/// Where the bytes come from.
#[derive(Clone, Debug)]
pub enum StreamSource {
    /// Read the file to its end.
    File(PathBuf),
    /// Run a program and read its merged stdout/stderr until it closes them.
    Process {
        program: PathBuf,
        args: Vec<OsString>,
        cwd: Option<PathBuf>,
    },
}

/// One item from a stream.
#[derive(Debug)]
pub enum StreamEvent {
    Data(Vec<u8>),
    /// The source finished (EOF) or failed to read.
    End(Result<(), String>),
}

/// A running byte source. Poll it with [`ByteStream::drain`].
#[derive(Debug)]
pub struct ByteStream {
    rx: Receiver<StreamEvent>,
    child: Option<Child>,
    ended: bool,
}

impl ByteStream {
    pub fn open(source: &StreamSource) -> io::Result<Self> {
        let (reader, child): (Box<dyn Read + Send>, Option<Child>) = match source {
            StreamSource::File(path) => (Box::new(File::open(path)?), None),
            StreamSource::Process { program, args, cwd } => {
                let (r, w) = io::pipe()?;
                let mut cmd = Command::new(program);
                cmd.args(args)
                    .stdin(Stdio::null())
                    .stdout(w.try_clone()?)
                    .stderr(w)
                    .process_group(0);
                if let Some(cwd) = cwd {
                    cmd.current_dir(cwd);
                }
                let child = cmd.spawn()?;
                // `cmd` holds the parent's copies of the write end; drop them
                // so EOF arrives when the child closes its side.
                drop(cmd);
                (Box::new(r), Some(child))
            }
        };
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("hack-term-stream-read".into())
            .spawn(move || read_into(reader, &tx))?;
        Ok(Self {
            rx,
            child,
            ended: false,
        })
    }

    /// Everything received so far, without blocking. `max_bytes` bounds one
    /// drain so a fast producer cannot starve the UI thread; the rest stays
    /// queued for the next call.
    pub fn drain(&mut self, max_bytes: usize) -> (Vec<u8>, Option<Result<(), String>>) {
        let mut out = Vec::new();
        let mut end = None;
        while out.len() < max_bytes && !self.ended {
            match self.rx.try_recv() {
                Ok(StreamEvent::Data(d)) => out.extend_from_slice(&d),
                Ok(StreamEvent::End(r)) => {
                    self.ended = true;
                    end = Some(r);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.ended = true;
                    end = Some(Ok(()));
                }
            }
        }
        (out, end)
    }

    /// Block until `n` bytes or the end arrive, or `deadline` passes. For tests.
    pub fn read_blocking(&mut self, n: usize, deadline: Duration) -> Vec<u8> {
        let start = Instant::now();
        let mut out = Vec::new();
        while out.len() < n && !self.ended && start.elapsed() < deadline {
            let left = deadline.saturating_sub(start.elapsed());
            match self.rx.recv_timeout(left) {
                Ok(StreamEvent::Data(d)) => out.extend_from_slice(&d),
                Ok(StreamEvent::End(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.ended = true;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
            }
        }
        out
    }

    /// The process group id of a process source.
    pub fn pid(&self) -> Option<u32> {
        self.child.as_ref().map(Child::id)
    }
}

impl Drop for ByteStream {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let Ok(pgid) = libc::pid_t::try_from(child.id()) else {
            return;
        };
        // SAFETY: signalling our own child's process group.
        unsafe {
            libc::kill(-pgid, libc::SIGTERM);
            libc::kill(-pgid, libc::SIGCONT);
        }
        let _ = std::thread::Builder::new()
            .name("hack-term-stream-reaper".into())
            .spawn(move || {
                let start = Instant::now();
                let mut killed = false;
                loop {
                    let group_alive = unsafe { libc::kill(-pgid, 0) } == 0;
                    let reaped = matches!(child.try_wait(), Ok(Some(_)) | Err(_));
                    if reaped && !group_alive {
                        return;
                    }
                    if !killed && start.elapsed() >= crate::pty::TERMINATE_GRACE {
                        unsafe {
                            libc::kill(-pgid, libc::SIGKILL);
                        }
                        killed = true;
                    }
                    if start.elapsed() >= Duration::from_secs(10) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            });
    }
}

fn read_into(mut reader: Box<dyn Read + Send>, tx: &mpsc::Sender<StreamEvent>) {
    let mut buf = vec![0u8; 64 * 1024];
    let end = loop {
        match reader.read(&mut buf) {
            Ok(0) => break Ok(()),
            Ok(n) => {
                if tx.send(StreamEvent::Data(buf[..n].to_vec())).is_err() {
                    return;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => break Err(e.kind().to_string()),
        }
    };
    let _ = tx.send(StreamEvent::End(end));
}
