//! An app-owned pseudo-terminal running one child in its own session.
//!
//! Ownership contract:
//!
//! - The child is started with `setsid()`: it leads a new session and a new
//!   process group whose id is its pid, and the PTY's slave side becomes its
//!   controlling terminal.
//! - [`Pty`] owns the master descriptor, the child handle and the session.
//!   Dropping it ends the whole session: it sends SIGHUP and SIGCONT to the
//!   process group and to every process still in the session (which includes
//!   jobs an interactive shell moved into their own process groups), closes
//!   the master, and hands escalation to a short-lived reaper thread that
//!   sends SIGKILL after [`TERMINATE_GRACE`] and reaps the child.
//! - A descendant that calls `setsid()` itself leaves the session and is not
//!   tracked; nothing short of a cgroup or job object can follow it.
//! - Drop never blocks the caller (the GPUI main thread) on the child. Use
//!   [`Pty::terminate_blocking`] where the caller must know the session is
//!   gone, for example before the process exits.
//!
//! The app writes only what the user typed or pasted into the master. It
//! never writes secrets, never logs terminal bytes and never passes values
//! through argv beyond the program and arguments the caller supplies.

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use crate::session;

/// How long a dropped session has after SIGHUP before SIGKILL.
pub const TERMINATE_GRACE: Duration = Duration::from_millis(300);

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
/// `env` entries are added to the inherited environment; `env_remove` names
/// are removed. Values are never logged.
#[derive(Clone, Debug)]
pub struct PtyOptions {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(OsString, OsString)>,
    pub env_remove: Vec<OsString>,
    pub size: PtySize,
}

impl PtyOptions {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: vec![("TERM".into(), "xterm-256color".into())],
            env_remove: Vec::new(),
            size: PtySize::cells(80, 24),
        }
    }

    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }
}

/// A child process on an app-owned PTY. See the module docs for ownership.
#[derive(Debug)]
pub struct Pty {
    master: Option<OwnedFd>,
    child: Option<Child>,
    leader: libc::pid_t,
}

impl Pty {
    /// Start `opts.program` on a new PTY in its own session.
    pub fn spawn(opts: &PtyOptions) -> io::Result<Self> {
        let (master, slave) = open_pty(opts.size)?;
        let mut cmd = Command::new(&opts.program);
        cmd.args(&opts.args);
        if let Some(cwd) = &opts.cwd {
            cmd.current_dir(cwd);
        }
        for name in &opts.env_remove {
            cmd.env_remove(name);
        }
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
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
                mark_inherited_fds_cloexec();
                Ok(())
            });
        }
        let child = cmd.spawn()?;
        let leader = libc::pid_t::try_from(child.id())
            .map_err(|_| io::Error::other("child pid out of range"))?;
        Ok(Self {
            master: Some(master),
            child: Some(child),
            leader,
        })
    }

    /// The session leader's pid, which is also the session and process group id.
    pub fn pid(&self) -> u32 {
        self.leader.unsigned_abs()
    }

    /// A reader for the child's output. Each call returns a new descriptor.
    pub fn reader(&self) -> io::Result<File> {
        Ok(File::from(self.master()?.try_clone()?))
    }

    /// A writer for the child's input. Each call returns a new descriptor.
    pub fn writer(&self) -> io::Result<File> {
        Ok(File::from(self.master()?.try_clone()?))
    }

    /// Write input bytes (keys, paste) to the child.
    pub fn write_all(&self, bytes: &[u8]) -> io::Result<()> {
        let mut f = self.writer()?;
        f.write_all(bytes)
    }

    /// Tell the child its new size (it receives SIGWINCH).
    pub fn resize(&self, size: PtySize) -> io::Result<()> {
        let ws = size.winsize();
        // SAFETY: TIOCSWINSZ reads a winsize from a valid pointer.
        let rc = unsafe { libc::ioctl(self.master()?.as_raw_fd(), libc::TIOCSWINSZ, &ws) };
        if rc == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// The child's exit status if it has exited.
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        match self.child.as_mut() {
            Some(c) => c.try_wait(),
            None => Ok(None),
        }
    }

    /// End the session and wait until the leader is reaped and no tracked
    /// session member remains, or `deadline` passes. Returns whether the
    /// session is gone.
    pub fn terminate_blocking(mut self, deadline: Duration) -> bool {
        let child = self.child.take();
        let master = self.master.take();
        hang_up(self.leader);
        drop(master);
        retire(self.leader, child, deadline)
    }

    fn master(&self) -> io::Result<&OwnedFd> {
        self.master
            .as_ref()
            .ok_or_else(|| io::Error::other("pty closed"))
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        let Some(child) = self.child.take() else {
            return;
        };
        hang_up(self.leader);
        drop(self.master.take());
        let leader = self.leader;
        // Escalation and reaping happen off the caller's thread.
        let spawned = std::thread::Builder::new()
            .name("hack-term-reaper".into())
            .spawn(move || retire(leader, Some(child), Duration::from_secs(10)));
        if spawned.is_err() {
            session::signal_session(leader, libc::SIGKILL);
        }
    }
}

/// SIGHUP + SIGCONT to the group and every tracked session member.
fn hang_up(leader: libc::pid_t) {
    session::signal_session(leader, libc::SIGHUP);
    session::signal_session(leader, libc::SIGCONT);
}

/// Wait for the session to exit, escalate to SIGKILL after the grace period,
/// and reap the leader. Returns whether the session is gone by `deadline`.
fn retire(leader: libc::pid_t, mut child: Option<Child>, deadline: Duration) -> bool {
    let start = Instant::now();
    let mut killed = false;
    loop {
        if let Some(c) = child.as_mut()
            && matches!(c.try_wait(), Ok(Some(_)) | Err(_))
        {
            child = None;
        }
        let members = session::members(leader);
        if child.is_none() && members.is_empty() {
            return true;
        }
        if !killed && start.elapsed() >= TERMINATE_GRACE {
            session::signal_session(leader, libc::SIGKILL);
            killed = true;
        }
        if start.elapsed() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
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
    set_cloexec(&master)?;
    set_cloexec(&slave)?;
    Ok((master, slave))
}

fn set_cloexec(fd: &OwnedFd) -> io::Result<()> {
    // SAFETY: fcntl on a valid descriptor.
    let rc = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
    if rc == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// In the forked child: mark every descriptor above stderr close-on-exec so
/// descriptors other threads opened without CLOEXEC do not reach the shell.
/// std's exec-error pipe is already CLOEXEC, so marking (not closing) keeps
/// spawn error reporting intact.
fn mark_inherited_fds_cloexec() {
    #[cfg(target_os = "linux")]
    {
        const CLOSE_RANGE_CLOEXEC: libc::c_uint = 1 << 2;
        // SAFETY: close_range only changes descriptor flags here.
        let rc = unsafe {
            libc::syscall(
                libc::SYS_close_range,
                3 as libc::c_uint,
                libc::c_uint::MAX,
                CLOSE_RANGE_CLOEXEC,
            )
        };
        if rc == 0 {
            return;
        }
    }
    // SAFETY: sysconf and fcntl are async-signal-safe.
    let max = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
    let max = if max <= 0 { 1024 } else { max.min(65_536) };
    for fd in 3..max as libc::c_int {
        unsafe {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
    }
}

/// Read the PTY in a background thread and hand chunks to `sink` until EOF
/// or error. Returns the thread handle. The PTY returns EIO on Linux once the
/// last slave descriptor closes; that is treated as EOF.
pub fn spawn_reader(
    mut reader: File,
    mut sink: impl FnMut(Vec<u8>) -> bool + Send + 'static,
) -> io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("hack-term-pty-read".into())
        .spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !sink(buf[..n].to_vec()) {
                            break;
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }
        })
}
