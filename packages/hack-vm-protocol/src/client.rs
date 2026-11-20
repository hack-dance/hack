//! Synchronous host client on an already connected local stream.
use super::*;
use std::{
    io,
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};
// Reset the kernel timeout to the remaining absolute budget on every syscall.
pub struct Exchange<'a> {
    pub stream: &'a UnixStream,
    pub deadline: Instant,
}
impl Exchange<'_> {
    fn remaining(&self) -> io::Result<Duration> {
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or(io::ErrorKind::TimedOut.into())
    }
}
impl Read for Exchange<'_> {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        self.stream.set_read_timeout(Some(self.remaining()?))?;
        self.stream.read(b)
    }
}
impl Write for Exchange<'_> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        self.stream.write(b)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
/// A session permits exactly one request after negotiation.
pub trait GuestClient {
    fn execute(self, request: &Request) -> Result<Response, Error>;
}

pub struct Session<'a> {
    io: Exchange<'a>,
    pub boot: String,
    pub incarnation: String,
}
impl<'a> Session<'a> {
    pub fn negotiate(stream: &'a UnixStream, timeout: Duration) -> Result<Self, Error> {
        let mut io = Exchange {
            stream,
            deadline: Instant::now().checked_add(timeout).ok_or(Error::Invalid)?,
        };
        write_frame(
            &mut io,
            &Request::Hello {
                min: VERSION,
                max: VERSION,
            },
        )?;
        let Response::Welcome {
            version: VERSION,
            boot,
            incarnation,
        } = read_frame(&mut io)?
        else {
            return Err(Error::Invalid);
        };
        Ok(Self {
            io,
            boot,
            incarnation,
        })
    }
}
impl GuestClient for Session<'_> {
    fn execute(mut self, request: &Request) -> Result<Response, Error> {
        write_frame(&mut self.io, request)?;
        read_frame(&mut self.io)
    }
}
