//! An app-owned pseudo-terminal running one child in its own session.
//!
//! Ownership contract:
//!
//! - The child is started with `setsid()`: it leads a new session and a new
//!   process group whose id is its pid, and the PTY's slave side becomes its
//!   controlling terminal.
//! - [`Pty`] owns the master descriptor and the session
//!   ([`crate::session`]). Dropping it ends the whole session: SIGHUP and
//!   SIGCONT to the leader's group and to every verified session member
//!   (which includes jobs an interactive shell moved into their own process
//!   groups), then SIGKILL after [`TERMINATE_GRACE`] on a short-lived reaper
//!   thread, which reaps the leader last.
//! - Nothing here blocks the caller on the child. Output is read by a worker
//!   into a byte-bounded queue ([`OUTPUT_QUEUE_BYTES`]); when the consumer
//!   stalls, the worker stops reading and the child blocks on its own write.
//!   Input is queued ([`INPUT_QUEUE_BYTES`]) and written by a second worker
//!   with non-blocking writes; input that does not fit is refused whole and
//!   reported, never truncated. Both workers stop when the `Pty` goes away.
//! - If a worker or reaper thread cannot be started, the calling thread
//!   keeps the responsibility: it kills the session and reaps the child.
//!
//! The app writes only what the user typed or pasted into the master. It
//! never writes secrets, never logs terminal bytes and never passes values
//! through argv beyond the program and arguments the caller supplies.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::fdio::{self, Cancel, CancelWatch, Wait};
use crate::queue::ByteQueue;
use crate::session::{
    ExitInfo, Hurry, LastResort, OwnedSession, PendingTeardown, SYNC_DEADLINE, Teardown,
    ThreadSpawner,
};

/// How long a dropped session has after SIGHUP before SIGKILL.
pub const TERMINATE_GRACE: Duration = Duration::from_millis(300);
/// The grace an open tab's session gets after SIGHUP when the whole app
/// is quitting: long enough for a shell to save its history, short enough
/// that SIGKILL lands well inside GPUI's 200 ms shutdown window under load.
pub const QUIT_GRACE: Duration = Duration::from_millis(50);
/// Most child output held in memory before the reader stops reading.
pub const OUTPUT_QUEUE_BYTES: usize = 1 << 20;
/// Most input (keys, paste) held for a child that is not reading.
pub const INPUT_QUEUE_BYTES: usize = 1 << 20;

/// Terminal size in cells and pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
}

impl PtySize {
    pub fn cells(cols: u16, rows: u16) -> Self {
        Self {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        }
    }

    fn winsize(self) -> libc::winsize {
        libc::winsize {
            ws_row: self.rows.max(1),
            ws_col: self.cols.max(1),
            ws_xpixel: self.pixel_width,
            ws_ypixel: self.pixel_height,
        }
    }
}

/// What to run on the PTY.
///
/// `env` entries are added to the inherited environment (or to an empty one
/// when `env_clear` is set); `env_remove` names are removed. Values are
/// never logged.
#[derive(Clone, Debug)]
pub struct PtyOptions {
    pub program: PathBuf,
    /// The child's `argv[0]` when it must differ from the program path. A
    /// leading `-` is how a shell is told it is a login shell.
    pub arg0: Option<OsString>,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(OsString, OsString)>,
    pub env_remove: Vec<OsString>,
    pub env_clear: bool,
    pub size: PtySize,
}

impl PtyOptions {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            arg0: None,
            args: Vec::new(),
            cwd: None,
            env: vec![("TERM".into(), "xterm-256color".into())],
            env_remove: Vec::new(),
            env_clear: false,
            size: PtySize::cells(80, 24),
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

/// What happened to input handed to [`Pty::write`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteOutcome {
    /// Accepted; the writer will deliver all of it, in order.
    Queued,
    /// Refused whole: the child is not reading and the queue is full, or the
    /// input is larger than the queue. Nothing was delivered.
    Dropped { bytes: usize },
    /// The terminal is closed.
    Closed,
}

/// Output taken from the PTY.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PtyRead {
    pub bytes: Vec<u8>,
    /// Every holder of the terminal has closed it and all output was
    /// delivered. Separate from the child's exit: see [`Pty::exit`].
    pub eof: bool,
}

#[derive(Debug, Default)]
struct InputState {
    chunks: VecDeque<Vec<u8>>,
    /// Queued bytes plus the unsent part of the chunk being written.
    pending: usize,
    closed: bool,
}

#[derive(Debug)]
struct InputQueue {
    state: Mutex<InputState>,
    ready: Condvar,
    cap: usize,
}

impl InputQueue {
    fn lock(&self) -> MutexGuard<'_, InputState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn offer(&self, bytes: &[u8]) -> WriteOutcome {
        let mut s = self.lock();
        if s.closed {
            return WriteOutcome::Closed;
        }
        if bytes.is_empty() {
            return WriteOutcome::Queued;
        }
        if s.pending + bytes.len() > self.cap {
            return WriteOutcome::Dropped { bytes: bytes.len() };
        }
        s.pending += bytes.len();
        s.chunks.push_back(bytes.to_vec());
        drop(s);
        self.ready.notify_all();
        WriteOutcome::Queued
    }

    fn close(&self) {
        let mut s = self.lock();
        s.closed = true;
        s.chunks.clear();
        s.pending = 0;
        drop(s);
        self.ready.notify_all();
    }

    /// Writer: the next chunk, or `None` once closed.
    fn next(&self) -> Option<Vec<u8>> {
        let mut s = self.lock();
        loop {
            if s.closed {
                return None;
            }
            if let Some(chunk) = s.chunks.pop_front() {
                return Some(chunk);
            }
            s = self.ready.wait(s).unwrap_or_else(|e| e.into_inner());
        }
    }

    fn sent(&self, n: usize) {
        let mut s = self.lock();
        s.pending = s.pending.saturating_sub(n);
    }
}

/// Why [`Pty::spawn`] failed, with the child's pid when one had started.
#[derive(Debug)]
pub(crate) struct SpawnFailure {
    pub error: io::Error,
    #[cfg_attr(not(test), allow(dead_code, reason = "read by tests"))]
    pub leader: Option<libc::pid_t>,
}

/// A child process on an app-owned PTY. See the module docs for ownership.
#[derive(Debug)]
pub struct Pty {
    leader: libc::pid_t,
    /// `Some` until teardown starts.
    pub(crate) session: Option<OwnedSession>,
    master: Option<OwnedFd>,
    output: Arc<ByteQueue>,
    input: Arc<InputQueue>,
    cancel: Option<Cancel>,
    threads: Vec<JoinHandle<()>>,
    spawner: ThreadSpawner,
}

impl Pty {
    /// Start `opts.program` on a new PTY in its own session.
    pub fn spawn(opts: &PtyOptions) -> io::Result<Self> {
        Self::spawn_with(opts, ThreadSpawner::os()).map_err(|f| f.error)
    }

    pub(crate) fn spawn_with(
        opts: &PtyOptions,
        spawner: ThreadSpawner,
    ) -> Result<Self, SpawnFailure> {
        let early = |error| SpawnFailure {
            error,
            leader: None,
        };
        let (master, slave) = open_pty(opts.size).map_err(early)?;
        // Non-blocking is a property of the open file description, so it
        // covers the reader's and writer's duplicates too. The slave is a
        // different description; the child is unaffected.
        fdio::set_nonblocking(&master).map_err(early)?;
        let (cancel, watch) = fdio::cancel_pair().map_err(early)?;
        let reader = File::from(master.try_clone().map_err(early)?);
        let writer = File::from(master.try_clone().map_err(early)?);

        let mut cmd = Command::new(&opts.program);
        if let Some(arg0) = &opts.arg0 {
            cmd.arg0(arg0);
        }
        cmd.args(&opts.args);
        if let Some(cwd) = &opts.cwd {
            cmd.current_dir(cwd);
        }
        if opts.env_clear {
            cmd.env_clear();
        }
        for name in &opts.env_remove {
            cmd.env_remove(name);
        }
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::from(slave.try_clone().map_err(early)?))
            .stdout(Stdio::from(slave.try_clone().map_err(early)?))
            .stderr(Stdio::from(slave));
        // SAFETY: only async-signal-safe calls (setsid, ioctl, fcntl,
        // syscall) run between fork and exec.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                // stdin is the slave: make it the controlling terminal.
                #[allow(clippy::useless_conversion, reason = "TIOCSCTTY's type differs by OS")]
                if libc::ioctl(0, libc::TIOCSCTTY.into(), 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
                fdio::mark_inherited_fds_cloexec();
                Ok(())
            });
        }
        let child = cmd.spawn().map_err(early)?;
        // The command holds the parent's copies of the slave; close them so
        // the terminal reports end of file when the session is gone.
        drop(cmd);
        // From here the child is owned: an early return ends and reaps it.
        let session = OwnedSession::new(child).map_err(early)?;
        let leader = session.leader();
        let mut pty = Self {
            leader,
            session: Some(session),
            master: Some(master),
            output: ByteQueue::new(OUTPUT_QUEUE_BYTES),
            input: Arc::new(InputQueue {
                state: Mutex::default(),
                ready: Condvar::new(),
                cap: INPUT_QUEUE_BYTES,
            }),
            cancel: Some(cancel),
            threads: Vec::new(),
            spawner,
        };
        let (queue, watch_r) = (pty.output.clone(), watch.clone());
        let read_job = Box::new(move || read_loop(reader, &watch_r, &queue));
        let input = pty.input.clone();
        let write_job = Box::new(move || write_loop(&writer, &watch, &input));
        for (name, job) in [
            ("hack-term-pty-read", read_job as crate::session::Job),
            ("hack-term-pty-write", write_job),
        ] {
            match pty.spawner.spawn(name, job) {
                Ok(handle) => pty.threads.push(handle),
                Err(error) => {
                    pty.abort();
                    return Err(SpawnFailure {
                        error,
                        leader: Some(leader),
                    });
                }
            }
        }
        Ok(pty)
    }

    /// The session leader's pid, which is also the session and process group id.
    pub fn pid(&self) -> u32 {
        self.leader.unsigned_abs()
    }

    /// Take output without blocking: whole chunks until at least `max_bytes`.
    pub fn read(&self, max_bytes: usize) -> PtyRead {
        let d = self.output.drain(max_bytes);
        PtyRead {
            bytes: d.bytes,
            eof: d.end.is_some(),
        }
    }

    /// [`Self::read`], first waiting up to `timeout` for output or the end.
    pub fn read_timeout(&self, max_bytes: usize, timeout: Duration) -> PtyRead {
        self.output.wait(timeout);
        self.read(max_bytes)
    }

    /// Output bytes read from the child and not yet taken.
    pub fn pending_output_bytes(&self) -> usize {
        self.output.pending_bytes()
    }

    /// Queue input (keys, paste, query replies) for the child. Never blocks.
    pub fn write(&self, bytes: &[u8]) -> WriteOutcome {
        self.input.offer(bytes)
    }

    /// Input accepted and not yet taken by the terminal.
    pub fn pending_input_bytes(&self) -> usize {
        self.input.lock().pending
    }

    /// Tell the child its new size (it receives SIGWINCH).
    pub fn resize(&self, size: PtySize) -> io::Result<()> {
        let master = self
            .master
            .as_ref()
            .ok_or_else(|| io::Error::other("pty closed"))?;
        let ws = size.winsize();
        // SAFETY: TIOCSWINSZ reads a winsize from a valid pointer.
        if unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &ws) } == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// The child's exit, if it has exited. Does not reap it and does not
    /// mean its output has all arrived: see [`PtyRead::eof`].
    pub fn exit(&self) -> Option<ExitInfo> {
        self.session.as_ref().and_then(OwnedSession::exit)
    }

    /// Whether the slave has turned off terminal echo, as sudo does while
    /// reading a password. No terminal input is read by this query.
    #[cfg(feature = "ghostty")]
    pub(crate) fn echo_disabled(&self) -> bool {
        let Some(master) = &self.master else {
            return false;
        };
        let mut termios = std::mem::MaybeUninit::<libc::termios>::uninit();
        // SAFETY: the master is open and tcgetattr initializes the struct on success.
        unsafe {
            libc::tcgetattr(master.as_raw_fd(), termios.as_mut_ptr()) == 0
                && termios.assume_init().c_lflag & libc::ECHO == 0
        }
    }

    /// End the session on this thread and wait until the leader is reaped
    /// and no session member remains, or `deadline` passes.
    pub fn terminate_blocking(self, deadline: Duration) -> Teardown {
        self.terminate_blocking_with(TERMINATE_GRACE, deadline)
    }

    /// [`Self::terminate_blocking`] with the SIGKILL grace chosen by the caller.
    pub fn terminate_blocking_with(mut self, grace: Duration, deadline: Duration) -> Teardown {
        let Some(session) = self.session.take() else {
            return Teardown::nothing();
        };
        hang_up(&session);
        let threads = self.stop_io();
        session.retire(
            grace,
            deadline,
            move || join_all(threads),
            LastResort::GiveUp,
        )
    }

    /// End the session on a reaper thread and get a handle to the result,
    /// so the caller can report [`Teardown::survivors`] without waiting.
    pub fn terminate_in_background(mut self) -> PendingTeardown {
        let (tx, rx) = std::sync::mpsc::channel();
        // This session already had its hangup and SIGTERM. At quit nothing
        // is gained by waiting: SIGKILL at once, so it lands well inside
        // GPUI's fixed shutdown window even on a loaded machine.
        let hurry = Hurry::new(Duration::ZERO);
        match self.session.take() {
            None => {
                let _ = tx.send(Teardown::nothing());
            }
            Some(session) => {
                hang_up(&session);
                let threads = self.stop_io();
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

    /// Kill the session now and reap it, on this thread.
    fn abort(mut self) {
        if let Some(session) = self.session.take() {
            let threads = self.stop_io();
            session.retire(
                Duration::ZERO,
                SYNC_DEADLINE,
                move || join_all(threads),
                LastResort::GiveUp,
            );
        }
    }

    /// Cancel both workers and close our side of the terminal.
    fn stop_io(&mut self) -> Vec<JoinHandle<()>> {
        self.input.close();
        self.output.close();
        self.cancel.take();
        self.master.take();
        std::mem::take(&mut self.threads)
    }

    #[cfg(test)]
    pub(crate) fn set_spawner(&mut self, spawner: ThreadSpawner) {
        self.spawner = spawner;
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        let Some(session) = self.session.take() else {
            return;
        };
        hang_up(&session);
        let threads = self.stop_io();
        // Escalation and reaping happen off the caller's thread; if that
        // thread cannot start, `retire_in_background` does both here.
        session.retire_in_background(
            &self.spawner,
            TERMINATE_GRACE,
            Box::new(move || join_all(threads)),
            None,
            Hurry::new(QUIT_GRACE),
        );
    }
}

/// SIGHUP + SIGCONT to the leader's group and to every other session member
/// that has a race-free handle.
fn hang_up(session: &OwnedSession) {
    session.signal(libc::SIGHUP);
    session.signal(libc::SIGCONT);
}

fn join_all(threads: Vec<JoinHandle<()>>) {
    for t in threads {
        let _ = t.join();
    }
}

/// Read the terminal into the bounded queue until end of file, an error, or
/// cancellation. Linux reports EIO once the last slave descriptor closes.
fn read_loop(mut master: File, cancel: &CancelWatch, queue: &ByteQueue) {
    let mut buf = vec![0u8; 64 * 1024];
    let end = loop {
        match fdio::wait_fd(master.as_raw_fd(), libc::POLLIN, cancel, -1) {
            Ok(Wait::Cancelled) => return,
            Ok(Wait::Ready | Wait::TimedOut) => {}
            Err(e) => break Err(e.kind().to_string()),
        }
        match master.read(&mut buf) {
            Ok(0) => break Ok(()),
            Ok(n) => {
                // Blocks while the queue is full; false once the consumer left.
                if !queue.push(buf[..n].to_vec()) {
                    return;
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) => {}
            Err(e) if e.raw_os_error() == Some(libc::EIO) => break Ok(()),
            Err(e) => break Err(e.kind().to_string()),
        }
    };
    queue.finish(end);
}

/// Deliver queued input with non-blocking writes, waiting for room without
/// holding up anyone else. Stops on close, cancellation or a write error.
fn write_loop(mut master: &File, cancel: &CancelWatch, input: &InputQueue) {
    while let Some(chunk) = input.next() {
        let mut off = 0;
        while off < chunk.len() {
            match master.write(&chunk[off..]) {
                Ok(0) => return input.close(),
                Ok(n) => {
                    off += n;
                    input.sent(n);
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    match fdio::wait_fd(master.as_raw_fd(), libc::POLLOUT, cancel, -1) {
                        Ok(Wait::Ready | Wait::TimedOut) => {}
                        Ok(Wait::Cancelled) | Err(_) => return input.close(),
                    }
                }
                Err(_) => return input.close(),
            }
        }
    }
}

fn open_pty(size: PtySize) -> io::Result<(OwnedFd, OwnedFd)> {
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let mut ws = size.winsize();
    // `*const` on Linux, `*mut` on macOS; a raw pointer coerces to both.
    let ws_ptr: *mut libc::winsize = &mut ws;
    // SAFETY: openpty writes two descriptors on success; null name/termios
    // are allowed.
    let rc = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            ws_ptr,
        )
    };
    if rc == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: both descriptors are fresh and owned by us.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    // openpty has no CLOEXEC flag; close the window as soon as possible.
    fdio::set_cloexec(&master)?;
    fdio::set_cloexec(&slave)?;
    Ok((master, slave))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{Open, OsTable, ProcTable, exists, is_alive, members};
    use crate::testutil::{DEADLINE, Recorded, assert_no_trace, sh, tagged, wait_gone};
    use std::time::Instant;

    /// Collect output until `done` accepts it, the end, or the deadline.
    fn read_until(pty: &Pty, done: impl Fn(&str) -> bool) -> String {
        let start = Instant::now();
        let mut out = Vec::new();
        while start.elapsed() < DEADLINE {
            let r = pty.read_timeout(usize::MAX, Duration::from_millis(100));
            out.extend_from_slice(&r.bytes);
            if r.eof || done(&String::from_utf8_lossy(&out)) {
                break;
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn a_large_paste_to_a_child_that_never_reads_does_not_block_the_caller() {
        // Raw mode: unread input is kept, so the terminal fills and a
        // blocking write would hang. The child never reads stdin.
        let (opts, _home) = sh("stty raw -echo; echo ready; exec sleep 120");
        let pty = Pty::spawn(&opts).expect("spawn");
        let mut rec = Recorded::session(pty.pid());
        assert!(read_until(&pty, |t| t.contains("ready")).contains("ready"));

        let chunk = vec![b'x'; 64 * 1024];
        let (mut queued, mut dropped) = (0usize, 0usize);
        let start = Instant::now();
        for _ in 0..256 {
            match pty.write(&chunk) {
                WriteOutcome::Queued => queued += chunk.len(),
                WriteOutcome::Dropped { bytes } => dropped += bytes,
                WriteOutcome::Closed => panic!("terminal closed"),
            }
            assert!(pty.pending_input_bytes() <= INPUT_QUEUE_BYTES);
        }
        let offered = start.elapsed();
        assert!(
            offered < Duration::from_secs(10),
            "offering 16 MiB took {offered:?}"
        );
        assert!(
            queued > 0 && dropped > 0,
            "queued {queued}, dropped {dropped}"
        );
        // The terminal took what fits; the rest is parked with the writer.
        // A write on the caller's thread would be stuck right here.
        let start = Instant::now();
        let mut pending = pty.pending_input_bytes();
        loop {
            std::thread::sleep(Duration::from_millis(200));
            let now = pty.pending_input_bytes();
            if now == pending || start.elapsed() >= DEADLINE {
                break;
            }
            pending = now;
        }
        assert!(
            pending > 0,
            "the child is not reading, so input stays queued"
        );
        assert!(pending <= INPUT_QUEUE_BYTES);
        // Input larger than the queue is refused whole, never truncated.
        assert_eq!(
            pty.write(&vec![b'y'; INPUT_QUEUE_BYTES + 1]),
            WriteOutcome::Dropped {
                bytes: INPUT_QUEUE_BYTES + 1
            }
        );
        // Teardown cancels the parked writer: it joins both workers before
        // it reaps, so returning at all proves they stopped.
        let t = pty.terminate_blocking(DEADLINE);
        assert!(t.gone, "{t:?}");
        rec.done();
    }

    #[test]
    fn a_thread_spawn_failure_at_start_leaves_no_child_and_no_zombie() {
        // Fail the reader (0 successes), then the writer (1 success).
        for ok in 0..2 {
            let (opts, _home) = sh("exec sleep 120");
            let failure = Pty::spawn_with(&opts, ThreadSpawner::failing_after(ok))
                .expect_err("spawn must fail");
            let leader = failure.leader.expect("the child had started");
            assert!(
                failure.error.to_string().contains("injected"),
                "{:?}",
                failure.error
            );
            // If it was left running, this handle ends it when the test
            // unwinds; the assertion itself only reports.
            let mut rec = Recorded::session(leader.unsigned_abs());
            // Killed and reaped before the error returned: not even a zombie.
            assert_no_trace(leader, &format!("spawn failure after {ok} threads"));
            rec.done();
        }
    }

    #[test]
    fn a_reaper_spawn_failure_still_ends_and_reaps_the_session() {
        let (opts, _home) = sh("sleep 120 & echo \"kid=$!\"; wait");
        let mut pty = Pty::spawn(&opts).expect("spawn");
        let mut rec = Recorded::session(pty.pid());
        let kid = tagged(&read_until(&pty, |t| t.contains("kid=")), "kid").expect("kid");
        let leader = pty.leader;
        assert!(is_alive(kid) && is_alive(leader));
        pty.set_spawner(ThreadSpawner::failing_after(0));
        drop(pty);
        // No reaper thread could start, so Drop did the work itself. (If it
        // did not, `rec` kills what is left when this test unwinds.)
        assert!(members(leader).is_empty(), "session members remain");
        assert_no_trace(leader, "the leader was not reaped");
        assert!(wait_gone(&[kid]).is_empty());
        rec.done();
    }

    /// The real process table with the scan result, and what happens at
    /// the verification boundary, chosen by the test.
    struct Staged<'a> {
        scan: Vec<libc::pid_t>,
        at_boundary: Box<dyn Fn(libc::pid_t) + 'a>,
    }

    impl ProcTable for Staged<'_> {
        fn scan(&self, _leader: libc::pid_t) -> Vec<libc::pid_t> {
            self.scan.clone()
        }
        fn open(&self, pid: libc::pid_t) -> Open {
            OsTable.open(pid)
        }
        fn identity(&self, pid: libc::pid_t) -> Option<crate::session::Identity> {
            OsTable.identity(pid)
        }
        fn verified(&self, pid: libc::pid_t) {
            (self.at_boundary)(pid);
        }
    }

    const JOB_AND_SAME: &str =
        "set -m; sleep 120 & echo \"job=$!\"; set +m; sleep 121 & echo \"same=$!\"; wait";

    #[test]
    fn a_scanned_pid_that_is_no_longer_in_the_session_is_not_signalled() {
        // `job` is in its own process group, `same` in the leader's group.
        let (opts, _home) = sh(JOB_AND_SAME);
        let pty = Pty::spawn(&opts).expect("spawn");
        let mut rec = Recorded::session(pty.pid());
        let out = read_until(&pty, |t| t.contains("same="));
        let job = tagged(&out, "job").expect("job");
        let same = tagged(&out, "same").expect("same");
        // A process in a different session: what a recycled pid would be.
        let (other_opts, _home2) = sh("exec sleep 120");
        let other = Pty::spawn(&other_opts).expect("spawn other");
        let mut rec2 = Recorded::session(other.pid());
        let stranger = other.leader;
        assert!(is_alive(job) && is_alive(same) && is_alive(stranger));
        const NOBODY: libc::pid_t = 0x3fff_fff0;
        assert!(!exists(NOBODY));

        let table = Staged {
            scan: vec![job, same, stranger, NOBODY],
            at_boundary: Box::new(|_| {}),
        };
        let session = pty.session.as_ref().expect("session");
        let report = session.signal_with(libc::SIGTERM, &table);
        assert_eq!(report.skipped, vec![stranger, NOBODY], "{report:?}");
        assert!(
            wait_gone(&[same]).is_empty(),
            "the leader's group was signalled"
        );
        if cfg!(target_os = "linux") {
            // A pidfd reaches the job in its own group.
            assert_eq!(report.signalled, vec![job, same], "{report:?}");
            assert!(report.unreachable.is_empty());
            assert!(wait_gone(&[job]).is_empty());
        } else {
            // No race-free handle here: the job is reported, never signalled
            // by number.
            assert_eq!(report.signalled, vec![same], "{report:?}");
            assert_eq!(report.unreachable, vec![job], "{report:?}");
        }
        assert!(is_alive(stranger), "the other session was not touched");

        assert!(other.terminate_blocking(DEADLINE).gone);
        let t = pty.terminate_blocking(DEADLINE);
        if cfg!(target_os = "linux") {
            assert!(t.gone, "{t:?}");
        }
        rec.done();
        rec2.done();
    }

    /// The reuse window for real: the verified member dies and is reaped
    /// between verification and signalling. Its pidfd then names nobody.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_member_that_exits_at_the_boundary_is_not_signalled_by_number() {
        let (opts, _home) = sh(JOB_AND_SAME);
        let pty = Pty::spawn(&opts).expect("spawn");
        let mut rec = Recorded::session(pty.pid());
        let out = read_until(&pty, |t| t.contains("same="));
        let job = tagged(&out, "job").expect("job");
        // The test's own handle to the job, taken while it is known to be it.
        let Open::Handle(own) = OsTable.open(job) else {
            panic!("pidfd for the job");
        };
        let table = Staged {
            scan: vec![job],
            at_boundary: Box::new(|pid| {
                assert_eq!(pid, job);
                assert!(own.send(libc::SIGKILL));
                // The shell's `wait` reaps it; then the number is free.
                let start = Instant::now();
                while exists(job) && start.elapsed() < DEADLINE {
                    std::thread::sleep(Duration::from_millis(5));
                }
                assert!(!exists(job), "the job was not reaped");
            }),
        };
        let session = pty.session.as_ref().expect("session");
        let report = session.signal_with(libc::SIGTERM, &table);
        // The send went to the pinned, now dead, process: nobody got it.
        assert_eq!(report.skipped, vec![job], "{report:?}");
        assert!(report.signalled.is_empty() && report.unreachable.is_empty());
        assert!(pty.terminate_blocking(DEADLINE).gone);
        rec.done();
    }

    /// The OS process table, minus race-free handles: what teardown has to
    /// work with on macOS and on Linux kernels without pidfd.
    struct NoHandles;

    impl ProcTable for NoHandles {
        fn scan(&self, leader: libc::pid_t) -> Vec<libc::pid_t> {
            OsTable.scan(leader)
        }
        fn open(&self, _pid: libc::pid_t) -> Open {
            Open::Unsupported
        }
        fn identity(&self, pid: libc::pid_t) -> Option<crate::session::Identity> {
            OsTable.identity(pid)
        }
    }

    #[test]
    fn without_a_race_free_handle_a_job_in_another_group_is_left_alone_and_reported() {
        // The job ignores nothing; it simply never receives a signal,
        // because a non-interactive shell does not pass SIGHUP to its jobs
        // and we refuse to signal it by number. It ends by itself.
        let (opts, _home) =
            sh("set -m; sleep 4 & echo \"job=$!\"; set +m; sleep 120 & echo \"same=$!\"; wait");
        let mut pty = Pty::spawn(&opts).expect("spawn");
        let mut rec = Recorded::session(pty.pid());
        let leader = pty.leader;
        let out = read_until(&pty, |t| t.contains("same="));
        let job = tagged(&out, "job").expect("job");
        let same = tagged(&out, "same").expect("same");
        pty.session
            .as_mut()
            .expect("session")
            .set_table(std::sync::Arc::new(NoHandles));

        let start = Instant::now();
        let t = pty.terminate_blocking(DEADLINE);
        let took = start.elapsed();
        assert!(!t.gone, "{t:?}");
        assert_eq!(t.survivors, vec![job], "the survivor is named");
        assert!(is_alive(job), "and it was not signalled");
        assert!(
            !is_alive(same) && !exists(leader),
            "the anchored group is gone"
        );
        assert!(
            took < Duration::from_secs(3),
            "teardown stops once nothing more can be reached, took {took:?}"
        );
        assert!(wait_gone(&[job]).is_empty(), "it ends by itself");
        rec.done();
    }

    #[test]
    fn the_leader_stays_unreaped_until_signalling_is_done() {
        // The shell exits at once and leaves a job in another process group.
        let (opts, _home) = sh("set -m; sleep 3 & echo \"job=$!\"; exit 0");
        let pty = Pty::spawn(&opts).expect("spawn");
        let mut rec = Recorded::session(pty.pid());
        let leader = pty.leader;
        let job = tagged(&read_until(&pty, |t| t.contains("job=")), "job").expect("job");
        let start = Instant::now();
        while pty.exit().is_none() && start.elapsed() < DEADLINE {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(pty.exit(), Some(ExitInfo::Exited(0)));
        // Observing the exit did not reap: the pid, and with it the session
        // id, is still held, so the job is still findable as ours.
        assert!(exists(leader), "the leader must stay as the anchor");
        assert!(!is_alive(leader));
        assert_eq!(members(leader), vec![job]);
        let t = pty.terminate_blocking(DEADLINE);
        assert!(!exists(leader), "reaped after the last signal");
        if cfg!(target_os = "linux") {
            assert!(t.gone && t.survivors.is_empty(), "{t:?}");
        } else {
            // The job is in another group and gets no SIGHUP from a
            // non-interactive shell. Without a race-free handle it is left
            // alone and reported; it ends by itself after three seconds.
            assert_eq!(
                (t.gone, t.survivors.as_slice()),
                (false, &[job][..]),
                "{t:?}"
            );
        }
        assert!(wait_gone(&[job]).is_empty());
        rec.done();
    }

    #[test]
    fn sigkill_escalation_happens_only_for_a_session_that_ignores_hangup() {
        let (opts, _home) = sh("sleep 120 & echo \"kid=$!\"; wait");
        let pty = Pty::spawn(&opts).expect("spawn");
        let mut rec = Recorded::session(pty.pid());
        read_until(&pty, |t| t.contains("kid="));
        let t = pty.terminate_blocking(DEADLINE);
        assert_eq!(
            t,
            Teardown {
                gone: true,
                escalated: false,
                survivors: Vec::new()
            },
            "SIGHUP is enough for a cooperative session"
        );
        rec.done();

        let (opts, _home) =
            sh("trap '' HUP TERM; ( trap '' HUP TERM; exec sleep 120 ) & echo \"deaf=$!\"; wait");
        let pty = Pty::spawn(&opts).expect("spawn");
        let mut rec = Recorded::session(pty.pid());
        let deaf = tagged(&read_until(&pty, |t| t.contains("deaf=")), "deaf").expect("deaf");
        let start = Instant::now();
        let t = pty.terminate_blocking(DEADLINE);
        assert_eq!(
            t,
            Teardown {
                gone: true,
                escalated: true,
                survivors: Vec::new()
            }
        );
        assert!(
            start.elapsed() >= TERMINATE_GRACE,
            "SIGKILL came only after the grace period"
        );
        assert!(wait_gone(&[deaf]).is_empty());
        rec.done();
    }
}
