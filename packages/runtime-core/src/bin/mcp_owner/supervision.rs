//! Startup-only supervision. Permission to kill ends before a grant is sent.
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::time::{Duration, Instant};

use super::error;

struct UngrantedChild {
    pid: libc::pid_t,
    armed: bool,
}

impl Drop for UngrantedChild {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // SAFETY: this is our direct child, never reaped elsewhere. SIGCHLD was
        // reset before fork, so its PID cannot be reused before our waitpid.
        unsafe { libc::kill(self.pid, libc::SIGKILL) };
        loop {
            // SAFETY: no status output is requested; pid is our unreaped child.
            if unsafe { libc::waitpid(self.pid, std::ptr::null_mut(), 0) } >= 0 {
                break;
            }
            if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                break;
            }
        }
    }
}

pub(super) fn run(command: &mut Command) -> io::Result<()> {
    let (mut supervisor, backend) = UnixStream::pair()?;
    supervisor.set_nonblocking(true)?;
    // A stopped supervisor keeps its channel open. Bound the backend's blocking
    // grant exchange independently of the supervisor's own polling deadline.
    // These socket options survive exec; the backend closes this fd after grant
    // or refusal, so ordinary MCP sessions do not inherit the I/O deadline.
    backend.set_read_timeout(Some(Duration::from_secs(8)))?;
    backend.set_write_timeout(Some(Duration::from_secs(8)))?;
    let fd = backend.as_raw_fd();
    // SAFETY: backend owns this live descriptor. Only its channel endpoint must
    // survive exec; UnixStream creates the supervisor endpoint with CLOEXEC.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } < 0 {
        return Err(error("cannot transfer startup channel"));
    }
    command.env("HACK_MCP_STARTUP_FD", fd.to_string());
    // SAFETY: zeroed sigaction fields are valid storage; initialize the mask and
    // default disposition before installation. No child may auto-reap while we
    // retain kill authority. This startup supervisor is single-threaded.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = libc::SIG_DFL;
    if unsafe { libc::sigemptyset(&mut action.sa_mask) } != 0
        || unsafe { libc::sigaction(libc::SIGCHLD, &action, std::ptr::null_mut()) } != 0
    {
        return Err(error("cannot retain startup child ownership"));
    }
    // SAFETY: the native owner has no threads or runtime callbacks before fork.
    // The inherited lease stays live in both processes until grant or reaping.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(error("cannot start supervised backend"));
    }
    if pid == 0 {
        drop(supervisor);
        let _ = command.exec();
        // SAFETY: exec failed in the fork child; exit without running parent
        // recovery or inherited cleanup. Closing its channel reports failure.
        unsafe { libc::_exit(1) };
    }
    let mut child = UngrantedChild { pid, armed: true };
    drop(backend);
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut request = [0_u8; 2];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(error("backend readiness request timed out"));
        }
        let mut ready = libc::pollfd {
            fd: supervisor.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let milliseconds = remaining.as_millis().min(i32::MAX as u128) as i32;
        // SAFETY: ready is writable pollfd storage for the owned channel. Poll
        // supplies an absolute-deadline loop without changing socket timeouts
        // after peer closure (which can return EINVAL on macOS).
        let available = unsafe { libc::poll(&mut ready, 1, milliseconds.max(1)) };
        if available < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error("cannot observe backend readiness request"));
        }
        if available == 0 {
            continue;
        }
        // A stopped process may resume with queued readiness after its absolute
        // deadline. Poll readiness must not turn that stale request into a grant.
        if Instant::now() >= deadline {
            return Err(error("backend readiness request timed out"));
        }
        match supervisor.read(&mut request) {
            Ok(1) if request[0] == b'R' => break,
            Ok(0) => {
                return Err(error(
                    "backend refused startup; verify matching owner/backend artifacts",
                ));
            }
            Err(failure)
                if matches!(
                    failure.kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                ) =>
            {
                continue;
            }
            _ => return Err(error("backend readiness request failed or timed out")),
        }
    }
    // Commit before grant visibility (Startup.tla). No error or later timeout
    // may re-arm the guard: the child could already be serving another client.
    child.armed = false;
    // Even a failed write must not route through pre-grant recovery. Closing
    // the channel makes an ungranted backend fail closed; a delivered grant may
    // already have authorized sessions.
    // The single-byte write is nonblocking; failure closes the channel instead
    // of extending startup or introducing a post-commit kill path.
    let _ = supervisor.write_all(b"G");
    // The supervisor exits, leaving the lease in the backend and no idle helper.
    Ok(())
}
