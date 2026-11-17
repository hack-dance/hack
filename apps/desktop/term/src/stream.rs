//! Read-only byte sources for the terminal surface: a file or a process.
//!
//! A process source runs in its own session (`setsid`, no controlling
//! terminal) with stdin closed and stdout and stderr merged into one pipe,
//! in the order the process wrote them. It is owned the same way a PTY
//! child is ([`crate::session`]): dropping the [`ByteStream`] sends SIGTERM
//! and SIGCONT to the session, then SIGKILL after
//! [`crate::pty::TERMINATE_GRACE`], and reaps on a background thread.
//!
//! Bytes go through a queue bounded at [`STREAM_QUEUE_BYTES`]. When the
//! consumer stalls, the reader stops reading and the process blocks on its
//! pipe. Dropping the stream cancels the reader.
//!
//! Bytes are passed through as printed. Nothing here logs them.

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::fdio::{self, Cancel, CancelWatch, Wait};
use crate::pty::{QUIT_GRACE, TERMINATE_GRACE};
use crate::queue::ByteQueue;
use crate::session::{
    Hurry, LastResort, OwnedSession, PendingTeardown, SYNC_DEADLINE, Teardown, ThreadSpawner,
};

/// Most stream bytes held in memory before the reader stops reading.
pub const STREAM_QUEUE_BYTES: usize = 1 << 20;

/// A program to run as a byte source.
///
/// `env` entries are added to the inherited environment, or to an empty one
/// when `env_clear` is set. Values are never logged.
#[derive(Clone, Debug)]
pub struct ProcessSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(OsString, OsString)>,
    pub env_clear: bool,
}

impl ProcessSpec {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            env_clear: false,
        }
    }

    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }
}

/// Where the bytes come from.
#[derive(Clone, Debug)]
pub enum StreamSource {
    /// Read the file to its end.
    File(PathBuf),
    /// Run a program and read its merged stdout/stderr until it closes them.
    Process(ProcessSpec),
}

/// Why opening a stream failed, with the child's pid when one had started.
#[derive(Debug)]
pub(crate) struct OpenFailure {
    pub error: io::Error,
    #[cfg_attr(not(test), allow(dead_code, reason = "read by tests"))]
    pub leader: Option<libc::pid_t>,
}

/// A running byte source. Poll it with [`ByteStream::drain`].
#[derive(Debug)]
pub struct ByteStream {
    queue: Arc<ByteQueue>,
    session: Option<OwnedSession>,
    cancel: Option<Cancel>,
    threads: Vec<JoinHandle<()>>,
    spawner: ThreadSpawner,
    ended: bool,
}

impl ByteStream {
    pub fn open(source: &StreamSource) -> io::Result<Self> {
        Self::open_with(source, ThreadSpawner::os()).map_err(|f| f.error)
    }

    pub(crate) fn open_with(
        source: &StreamSource,
        spawner: ThreadSpawner,
    ) -> Result<Self, OpenFailure> {
        let early = |error| OpenFailure {
            error,
            leader: None,
        };
        let (cancel, watch) = fdio::cancel_pair().map_err(early)?;
        let (reader, session): (File, Option<OwnedSession>) = match source {
            StreamSource::File(path) => (open_regular(path).map_err(early)?, None),
            StreamSource::Process(spec) => {
                let (r, w) = io::pipe().map_err(early)?;
                let mut cmd = Command::new(&spec.program);
                cmd.args(&spec.args)
                    .stdin(Stdio::null())
                    .stdout(w.try_clone().map_err(early)?)
                    .stderr(w);
                if let Some(cwd) = &spec.cwd {
                    cmd.current_dir(cwd);
                }
                if spec.env_clear {
                    cmd.env_clear();
                }
                for (k, v) in &spec.env {
                    cmd.env(k, v);
                }
                // SAFETY: only async-signal-safe calls run between fork and exec.
                unsafe {
                    cmd.pre_exec(|| {
                        if libc::setsid() == -1 {
                            return Err(io::Error::last_os_error());
                        }
                        fdio::mark_inherited_fds_cloexec();
                        Ok(())
                    });
                }
                let child = cmd.spawn().map_err(early)?;
                // `cmd` holds the parent's copies of the write end; drop them
                // so end of file arrives when the session closes its side.
                drop(cmd);
                // From here the child is owned: an early return ends and reaps it.
                let session = OwnedSession::new(child).map_err(early)?;
                (File::from(OwnedFd::from(r)), Some(session))
            }
        };
        let leader = session.as_ref().map(OwnedSession::leader);
        let mut stream = Self {
            queue: ByteQueue::new(STREAM_QUEUE_BYTES),
            session,
            cancel: Some(cancel),
            threads: Vec::new(),
            spawner,
            ended: false,
        };
        let queue = stream.queue.clone();
        let job = Box::new(move || read_loop(reader, &watch, &queue));
        match stream.spawner.spawn("hack-term-stream-read", job) {
            Ok(handle) => stream.threads.push(handle),
            Err(error) => {
                stream.abort();
                return Err(OpenFailure { error, leader });
            }
        }
        Ok(stream)
    }

    /// Everything received so far, without blocking: whole chunks until at
    /// least `max_bytes`. The second value is set once, at the end.
    pub fn drain(&mut self, max_bytes: usize) -> (Vec<u8>, Option<Result<(), String>>) {
        if self.ended {
            return (Vec::new(), None);
        }
        let d = self.queue.drain(max_bytes);
        self.ended = d.end.is_some();
        (d.bytes, d.end)
    }

    /// Block until `n` bytes or the end arrive, or `deadline` passes. For tests.
    pub fn read_blocking(&mut self, n: usize, deadline: Duration) -> Vec<u8> {
        let start = Instant::now();
        let mut out = Vec::new();
        while out.len() < n && !self.ended && start.elapsed() < deadline {
            self.queue.wait(deadline.saturating_sub(start.elapsed()));
            out.extend_from_slice(&self.drain(n - out.len()).0);
        }
        out
    }

    /// Whether the end of the source has been drained.
    pub fn is_ended(&self) -> bool {
        self.ended
    }

    /// Bytes read from the source and not yet drained.
    pub fn pending_bytes(&self) -> usize {
        self.queue.pending_bytes()
    }

    /// The most bytes ever pending at once.
    pub fn high_water_bytes(&self) -> usize {
        self.queue.high_water()
    }

    /// The session (and process group) id of a process source.
    pub fn pid(&self) -> Option<u32> {
        self.session.as_ref().map(|s| s.leader().unsigned_abs())
    }

    fn stop_io(&mut self) -> Vec<JoinHandle<()>> {
        self.queue.close();
        self.cancel.take();
        std::mem::take(&mut self.threads)
    }

    /// End a process source on this thread: SIGTERM and SIGCONT, SIGKILL
    /// after `grace`, and wait until the session is reaped or `deadline`
    /// passes. A file source has nothing to end.
    pub fn terminate_blocking_with(mut self, grace: Duration, deadline: Duration) -> Teardown {
        let threads = self.stop_io();
        let Some(session) = self.session.take() else {
            join_all(threads);
            return Teardown::nothing();
        };
        session.signal(libc::SIGTERM);
        session.signal(libc::SIGCONT);
        session.retire(
            grace,
            deadline,
            move || join_all(threads),
            LastResort::GiveUp,
        )
    }

    /// [`Self::terminate_blocking_with`] with the default grace.
    pub fn terminate_blocking(self, deadline: Duration) -> Teardown {
        self.terminate_blocking_with(TERMINATE_GRACE, deadline)
    }

    /// End a process source on a reaper thread and get a handle to the result.
    pub fn terminate_in_background(mut self) -> PendingTeardown {
        let (tx, rx) = std::sync::mpsc::channel();
        let hurry = Hurry::new(QUIT_GRACE);
        let threads = self.stop_io();
        match self.session.take() {
            None => {
                let _ = tx.send(Teardown::nothing());
            }
            Some(session) => {
                session.signal(libc::SIGTERM);
                session.signal(libc::SIGCONT);
                session.retire_in_background(
                    &self.spawner,
                    TERMINATE_GRACE,
                    Box::new(move || join_all(threads)),
                    Some(tx),
                    hurry.clone(),
                );
            }
        }
        PendingTeardown::new(rx, hurry)
    }

    /// Kill the process now and reap it, on this thread.
    fn abort(mut self) {
        let threads = self.stop_io();
        if let Some(session) = self.session.take() {
            session.retire(
                Duration::ZERO,
                SYNC_DEADLINE,
                move || join_all(threads),
                LastResort::GiveUp,
            );
        }
    }

    #[cfg(test)]
    pub(crate) fn set_spawner(&mut self, spawner: ThreadSpawner) {
        self.spawner = spawner;
    }
}

/// Open a file stream's source: regular files only. The open itself never
/// blocks (a FIFO with no writer would block the caller, the UI thread,
/// indefinitely), and the check is made on the opened handle. Reads from a
/// regular file are unaffected by `O_NONBLOCK`.
fn open_regular(path: &std::path::Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY)
        .open(path)?;
    if file.metadata()?.is_file() {
        Ok(file)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a file stream reads regular files only",
        ))
    }
}

impl Drop for ByteStream {
    fn drop(&mut self) {
        let threads = self.stop_io();
        let Some(session) = self.session.take() else {
            return;
        };
        session.signal(libc::SIGTERM);
        session.signal(libc::SIGCONT);
        session.retire_in_background(
            &self.spawner,
            TERMINATE_GRACE,
            Box::new(move || join_all(threads)),
            None,
            Hurry::new(QUIT_GRACE),
        );
    }
}

fn join_all(threads: Vec<JoinHandle<()>>) {
    for t in threads {
        let _ = t.join();
    }
}

fn read_loop(mut reader: File, cancel: &CancelWatch, queue: &ByteQueue) {
    let mut buf = vec![0u8; 64 * 1024];
    let end = loop {
        match fdio::wait_fd(reader.as_raw_fd(), libc::POLLIN, cancel, -1) {
            Ok(Wait::Cancelled) => return,
            Ok(Wait::Ready | Wait::TimedOut) => {}
            Err(e) => break Err(e.kind().to_string()),
        }
        match reader.read(&mut buf) {
            Ok(0) => break Ok(()),
            Ok(n) => {
                // Blocks while the queue is full; false once the consumer left.
                if !queue.push(buf[..n].to_vec()) {
                    return;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => break Err(e.kind().to_string()),
        }
    };
    queue.finish(end);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{is_alive, members};
    use crate::testutil::{DEADLINE, Recorded, TempHome, assert_no_trace, tagged, wait_gone};

    fn sh_source(script: &str, home: &TempHome) -> StreamSource {
        StreamSource::Process(ProcessSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            cwd: Some(home.path().to_owned()),
            env: vec![
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("HOME".into(), home.path().into()),
            ],
            env_clear: true,
        })
    }

    #[test]
    fn opening_a_fifo_with_no_writer_fails_at_once_instead_of_blocking() {
        let home = TempHome::new();
        let fifo = home.path().join("logs.fifo");
        let c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: a valid NUL-terminated path and mode.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        // On a helper thread, so a regression fails the test instead of
        // hanging it.
        let (tx, rx) = std::sync::mpsc::channel();
        let source = StreamSource::File(fifo);
        std::thread::spawn(move || {
            let _ = tx.send(ByteStream::open(&source).map(|_| ()).map_err(|e| e.kind()));
        });
        let result = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("opening a FIFO returned at once");
        assert_eq!(result, Err(io::ErrorKind::InvalidInput));
        // A regular file still opens.
        let file = home.path().join("logs.txt");
        std::fs::write(&file, b"line\n").unwrap();
        assert!(ByteStream::open(&StreamSource::File(file)).is_ok());
    }

    #[test]
    fn a_reader_spawn_failure_leaves_no_child_and_no_zombie() {
        let home = TempHome::new();
        let failure = ByteStream::open_with(
            &sh_source("exec sleep 120", &home),
            ThreadSpawner::failing_after(0),
        )
        .expect_err("open must fail");
        let leader = failure.leader.expect("the child had started");
        assert!(failure.error.to_string().contains("injected"));
        // If it was left running, this handle ends it when the test unwinds.
        let mut rec = Recorded::session(leader.unsigned_abs());
        assert_no_trace(leader, "reader spawn failure");
        rec.done();
    }

    #[test]
    fn a_reaper_spawn_failure_still_ends_and_reaps_the_process() {
        let home = TempHome::new();
        let mut stream =
            ByteStream::open(&sh_source("sleep 120 & echo \"kid=$!\"; wait", &home)).expect("open");
        let leader = libc::pid_t::try_from(stream.pid().unwrap()).unwrap();
        let mut rec = Recorded::session(leader.unsigned_abs());
        let mut out = String::new();
        let start = Instant::now();
        while !out.contains("kid=") && start.elapsed() < DEADLINE {
            out.push_str(&String::from_utf8_lossy(
                &stream.read_blocking(1, Duration::from_millis(200)),
            ));
        }
        let kid = tagged(&out, "kid").expect("kid");
        assert!(is_alive(kid) && is_alive(leader));
        stream.set_spawner(ThreadSpawner::failing_after(0));
        drop(stream);
        assert!(members(leader).is_empty());
        assert_no_trace(leader, "the leader was not reaped");
        assert!(wait_gone(&[kid]).is_empty());
        rec.done();
    }
}
