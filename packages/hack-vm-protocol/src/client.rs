//! Synchronous command exchanges on a negotiated Unix stream.
use super::*;
use std::{
    io,
    os::{fd::AsRawFd, unix::net::UnixStream},
    time::{Duration, Instant},
};

/// Poll-based adapter with one absolute deadline and no socket option changes.
pub struct Exchange<'a> {
    /// Connected socket owned by the caller.
    pub stream: &'a UnixStream,
    /// Last instant at which an operation may begin.
    pub deadline: Instant,
}
impl Exchange<'_> {
    fn transfer(&self, events: i16, op: impl Fn() -> isize) -> io::Result<usize> {
        loop {
            let remaining = self
                .deadline
                .checked_duration_since(Instant::now())
                .filter(|d| !d.is_zero())
                .ok_or(io::ErrorKind::TimedOut)?;
            let mut fd = libc::pollfd {
                fd: self.stream.as_raw_fd(),
                events,
                revents: 0,
            };
            let ms = remaining
                .as_nanos()
                .div_ceil(1_000_000)
                .min(i32::MAX as u128) as i32;
            // SAFETY: the live stream owns fd and the single-element poll array.
            let ready = unsafe { libc::poll(&mut fd, 1, ms) };
            if ready == 0 {
                continue;
            }
            if ready < 0 {
                let err = io::Error::last_os_error();
                if err.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(err);
            }
            // HUP can coexist with readable bytes. recv decides EOF.
            if Instant::now() >= self.deadline {
                return Err(io::ErrorKind::TimedOut.into());
            }
            let n = op();
            if n >= 0 {
                return Ok(n as usize);
            }
            let err = io::Error::last_os_error();
            if !matches!(
                err.kind(),
                io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
            ) {
                return Err(err);
            }
        }
    }
}
impl Read for Exchange<'_> {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        if b.is_empty() {
            return Ok(0);
        }
        let ptr = b.as_mut_ptr();
        // SAFETY: b remains exclusively borrowed throughout the recv call.
        self.transfer(libc::POLLIN, || unsafe {
            libc::recv(
                self.stream.as_raw_fd(),
                ptr.cast(),
                b.len(),
                libc::MSG_DONTWAIT,
            )
        })
    }
}
impl Write for Exchange<'_> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        if b.is_empty() {
            return Ok(0);
        }
        // Darwin can block on a large Unix socket send despite MSG_DONTWAIT.
        // A single writer can use the space guaranteed by POLLOUT.
        #[cfg(target_vendor = "apple")]
        let b = {
            let mut low: libc::c_int = 0;
            let mut len = std::mem::size_of_val(&low) as libc::socklen_t;
            // SAFETY: the live socket and both out-parameters remain valid.
            let status = unsafe {
                libc::getsockopt(
                    self.stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_SNDLOWAT,
                    (&mut low as *mut libc::c_int).cast(),
                    &mut len,
                )
            };
            let limit = if status == 0 { low.max(1) as usize } else { 1 };
            &b[..b.len().min(limit)]
        };
        // SAFETY: b is readable and the stream lives through send.
        self.transfer(libc::POLLOUT, || unsafe {
            libc::send(
                self.stream.as_raw_fd(),
                b.as_ptr().cast(),
                b.len(),
                libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
            )
        })
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Host-side command transport. Each call uses a new channel on the session.
pub trait GuestClient {
    /// Submit one command and collect its final response.
    fn execute(&mut self, req: &Request) -> Result<Response, Error>;
}
/// Negotiated guest connection for buffered operations.
pub struct Session<'a> {
    stream: &'a UnixStream,
    timeout: Duration,
    next: Option<u32>,
    /// Validated guest boot ID.
    pub boot: String,
    /// Validated guest-agent incarnation.
    pub incarnation: String,
    /// Selected wire version.
    pub version: u16,
    /// Agreed optional capabilities.
    pub capabilities: u64,
    /// Peer payload limit, including the seven-byte header.
    pub max_frame: u32,
    /// Complete inventory capacity.
    pub max_jobs: u16,
    /// Per-pipe retained bytes.
    pub output_retention: u32,
}
impl<'a> Session<'a> {
    /// Offer all implemented versions and no optional extensions.
    pub fn negotiate(stream: &'a UnixStream, timeout: Duration) -> Result<Self, Error> {
        Self::offer(stream, timeout, (1, VERSION), 0)
    }
    /// Open a command session only after Facts confirms the negotiated guest identity.
    /// Negotiation and Facts share one timeout. Subsequent commands each get the full timeout.
    pub fn ready(stream: &'a UnixStream, timeout: Duration) -> Result<Self, Error> {
        let started = Instant::now();
        let mut session = Self::negotiate(stream, timeout)?;
        session.timeout = timeout
            .checked_sub(started.elapsed())
            .ok_or(Error::Deadline)?;
        match session.execute(&Request::Facts {})? {
            Response::Facts {
                boot, incarnation, ..
            } if boot == session.boot && incarnation == session.incarnation => {}
            _ => return Err(Error::Invalid),
        }
        session.timeout = timeout;
        Ok(session)
    }

    /// Restrict the offered version range and capabilities to implemented schemas.
    pub fn offer(
        stream: &'a UnixStream,
        timeout: Duration,
        range: (u16, u16),
        capabilities: u64,
    ) -> Result<Self, Error> {
        let min = range.0.max(1);
        let max = range.1.min(VERSION);
        if min > max {
            return Err(Error::Invalid);
        }
        let mut io = Exchange {
            stream,
            deadline: Instant::now().checked_add(timeout).ok_or(Error::Invalid)?,
        };
        write_frame(
            &mut io,
            0,
            true,
            &Request::Hello {
                min,
                max,
                capabilities,
            },
        )?;
        let Frame {
            channel: 0,
            end: true,
            message:
                Response::Welcome {
                    version,
                    capabilities: selected,
                    max_frame,
                    max_jobs,
                    output_retention,
                    boot,
                    incarnation,
                },
        } = read_frame(&mut io)?
        else {
            return Err(Error::Invalid);
        };
        if !(min..=max).contains(&version) || selected & !capabilities != 0 {
            return Err(Error::Invalid);
        }
        Ok(Self {
            stream,
            timeout,
            next: Some(1),
            boot,
            incarnation,
            version,
            capabilities: selected,
            max_frame,
            max_jobs,
            output_retention,
        })
    }
}
impl GuestClient for Session<'_> {
    fn execute(&mut self, req: &Request) -> Result<Response, Error> {
        let handle = match req {
            Request::Start { handle, .. }
            | Request::Signal { handle, .. }
            | Request::Inspect { handle }
            | Request::Output { handle, .. }
            | Request::Release { handle } => Some(handle),
            Request::Hello { .. } => return Err(Error::Invalid),
            Request::Facts {} | Request::List {} => None,
        };
        if handle.is_some_and(|h| h.boot != self.boot || h.incarnation != self.incarnation) {
            return Err(Error::StaleHandle);
        }
        let channel = self.next.take().ok_or(Error::Closed)?;
        let mut io = Exchange {
            stream: self.stream,
            deadline: Instant::now()
                .checked_add(self.timeout)
                .ok_or(Error::Invalid)?,
        };
        write_frame_limited(&mut io, channel, true, req, self.max_frame as usize)?;
        let reply = read_frame(&mut io)?;
        if reply.channel != channel || !reply.end {
            return Err(Error::Invalid);
        }
        self.next = channel.checked_add(1);
        Ok(reply.message)
    }
}
