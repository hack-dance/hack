//! Single-connection authenticated client. Callers own transport provenance and
//! private credential delivery; framing supplies integrity, not encryption.
use super::{
    relay_auth::{Credential, SERVER_HELLO_BYTES},
    relay_frame::{Frame, MAX_DATA},
    relay_integrity::{MAX_WIRE, Traffic},
};
use crate::CandidateError;
use std::{
    io::{self, Read, Write},
    net::{Shutdown, TcpStream},
    os::{fd::AsRawFd, unix::net::UnixStream},
    time::{Duration, Instant},
};

/// Owned application socket used directly by the authenticated client.
/// Implementations must expose the same live socket for I/O and polling, honor
/// nonblocking mode, and support independent write-half shutdown. Callers must
/// not retain descriptor duplicates that defeat ownership and close semantics.
pub trait ApplicationStream: Read + Write + AsRawFd {
    fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()>;
    fn shutdown(&self, how: Shutdown) -> io::Result<()>;
}
impl ApplicationStream for UnixStream {
    fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        UnixStream::set_nonblocking(self, nonblocking)
    }
    fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        UnixStream::shutdown(self, how)
    }
}
impl ApplicationStream for TcpStream {
    fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        TcpStream::set_nonblocking(self, nonblocking)
    }
    fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        TcpStream::shutdown(self, how)
    }
}

#[derive(Clone, Copy)]
pub struct Limits {
    pub handshake_timeout: Duration,
    pub idle_timeout: Duration,
}
#[derive(Debug, Default)]
pub struct Stats {
    pub application_bytes_sent: u64,
    pub application_bytes_received: u64,
    pub peak_queued_bytes: usize,
}
fn refused() -> CandidateError {
    CandidateError::new("relay_client", "Authenticated client transport failed.")
}
fn timeout() -> CandidateError {
    CandidateError::new(
        "relay_client_timeout",
        "Authenticated client deadline expired.",
    )
}
fn retry(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}
fn event(stream: &impl AsRawFd, read: bool, write: bool) -> libc::pollfd {
    libc::pollfd {
        fd: if read || write {
            stream.as_raw_fd()
        } else {
            -1
        },
        events: (if read { libc::POLLIN } else { 0 }) | (if write { libc::POLLOUT } else { 0 }),
        revents: 0,
    }
}
fn wait(fds: &mut [libc::pollfd], deadline: Instant) -> Result<(), CandidateError> {
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(timeout());
        }
        let remaining = deadline.saturating_duration_since(now);
        let millis = remaining
            .as_millis()
            .saturating_add(1)
            .min(i32::MAX as u128) as i32;
        // SAFETY: fds is initialized writable storage of the supplied element count;
        // all borrowed descriptors remain owned by this call's caller.
        let result = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, millis) };
        if result < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(refused());
        }
        if Instant::now() >= deadline {
            return Err(timeout());
        }
        if fds
            .iter()
            .any(|fd| fd.revents & (libc::POLLERR | libc::POLLNVAL) != 0)
        {
            return Err(refused());
        }
        if result > 0 {
            return Ok(());
        }
    }
}
fn send(stream: &mut UnixStream, bytes: &[u8], deadline: Instant) -> Result<(), CandidateError> {
    let mut used = 0;
    while used < bytes.len() {
        wait(&mut [event(stream, false, true)], deadline)?;
        match stream.write(&bytes[used..]) {
            Ok(0) => return Err(refused()),
            Ok(n) => used += n,
            Err(e) if retry(&e) => {}
            Err(_) => return Err(refused()),
        }
    }
    Ok(())
}
fn receive(
    stream: &mut UnixStream,
    bytes: &mut [u8],
    deadline: Instant,
) -> Result<(), CandidateError> {
    let mut used = 0;
    while used < bytes.len() {
        wait(&mut [event(stream, true, false)], deadline)?;
        match stream.read(&mut bytes[used..]) {
            Ok(0) => return Err(refused()),
            Ok(n) => used += n,
            Err(e) if retry(&e) => {}
            Err(_) => return Err(refused()),
        }
    }
    Ok(())
}
fn authenticate(
    stream: &mut UnixStream,
    credential: &Credential,
    budget: Duration,
) -> Result<Traffic, CandidateError> {
    let deadline = Instant::now() + budget;
    let (client, hello) = credential.begin()?;
    send(stream, &hello, deadline)?;
    let mut hello = [0; SERVER_HELLO_BYTES];
    receive(stream, &mut hello, deadline)?;
    let (client, proof) = client.answer(&hello)?;
    send(stream, &proof, deadline)?;
    let mut accepted = [0; 32];
    receive(stream, &mut accepted, deadline)?;
    Ok(client.accept(&accepted)?.into_traffic())
}
#[derive(Default)]
struct Queue {
    bytes: Vec<u8>,
    used: usize,
}
impl Queue {
    fn remaining(&self) -> usize {
        self.bytes.len() - self.used
    }
    fn empty(&self) -> bool {
        self.remaining() == 0
    }
    fn set(&mut self, bytes: Vec<u8>) {
        self.bytes = bytes;
        self.used = 0;
    }
    fn flush(&mut self, stream: &mut impl Write) -> Result<usize, CandidateError> {
        if self.empty() {
            return Ok(0);
        }
        match stream.write(&self.bytes[self.used..]) {
            Ok(0) => Err(refused()),
            Ok(n) => {
                self.used += n;
                Ok(n)
            }
            Err(e) if retry(&e) => Ok(0),
            Err(_) => Err(refused()),
        }
    }
}

/// Authenticate before consuming any application bytes, then relay to graceful
/// FIN in both directions. Owns and drops both sockets on success or refusal.
/// Completed frame delivery renews the connection idle window. Each partial
/// record and blocked output also has a fixed window which trickled bytes and
/// opposite-direction traffic cannot extend.
/// The caller must not retain descriptor duplicates that defeat close semantics.
pub fn run<A: ApplicationStream>(
    mut transport: UnixStream,
    mut application: A,
    credential: &Credential,
    limits: Limits,
) -> Result<Stats, CandidateError> {
    if limits.handshake_timeout.is_zero()
        || limits.handshake_timeout > Duration::from_secs(5)
        || limits.idle_timeout.is_zero()
        || limits.idle_timeout > Duration::from_secs(3600)
    {
        return Err(refused());
    }
    transport.set_nonblocking(true).map_err(|_| refused())?;
    application.set_nonblocking(true).map_err(|_| refused())?;
    let mut traffic = authenticate(&mut transport, credential, limits.handshake_timeout)?;
    let mut tx = Queue::default();
    let mut rx = Queue::default();
    let mut local_fin = false;
    let mut remote_fin = false;
    let mut transport_eof = false;
    let mut idle_deadline = Instant::now() + limits.idle_timeout;
    let mut tx_deadline: Option<Instant> = None;
    let mut rx_deadline: Option<Instant> = None;
    let mut stats = Stats::default();
    loop {
        if local_fin && remote_fin && tx.empty() && rx.empty() {
            return Ok(stats);
        }
        let deadline = tx_deadline
            .into_iter()
            .chain(rx_deadline)
            .fold(idle_deadline, Instant::min);
        let mut fds = [
            event(&transport, !transport_eof && rx.empty(), !tx.empty()),
            event(&application, !local_fin && tx.empty(), !rx.empty()),
        ];
        wait(&mut fds, deadline)?;
        if fds[0].revents & libc::POLLOUT != 0 && !tx.empty() {
            tx.flush(&mut transport)?;
            if tx.empty() {
                tx_deadline = None;
                idle_deadline = Instant::now() + limits.idle_timeout;
            }
        }
        if fds[1].revents & libc::POLLOUT != 0 && !rx.empty() {
            let n = rx.flush(&mut application)?;
            stats.application_bytes_received += n as u64;
            if rx.empty() {
                rx_deadline = None;
                idle_deadline = Instant::now() + limits.idle_timeout;
            }
        }
        if fds[0].revents & (libc::POLLIN | libc::POLLHUP) != 0 && !transport_eof && rx.empty() {
            let capacity = traffic.receive.read_capacity();
            if capacity == 0 || capacity > MAX_WIRE {
                return Err(refused());
            }
            let mut input = [0; MAX_WIRE];
            match transport.read(&mut input[..capacity]) {
                Ok(0) => {
                    traffic.receive.finish_transport()?;
                    transport_eof = true;
                }
                Ok(n) => {
                    rx_deadline.get_or_insert_with(|| Instant::now() + limits.idle_timeout);
                    let (used, frame) = traffic.receive.push(&input[..n])?;
                    if used != n {
                        return Err(refused());
                    }
                    match frame {
                        Some(Frame::Data(bytes)) => rx.set(bytes.to_vec()),
                        Some(Frame::Fin) => {
                            remote_fin = true;
                            rx_deadline = None;
                            idle_deadline = Instant::now() + limits.idle_timeout;
                            application
                                .shutdown(Shutdown::Write)
                                .map_err(|_| refused())?;
                        }
                        Some(Frame::Reset) => return Err(refused()),
                        None => {}
                    }
                }
                Err(e) if retry(&e) => {}
                Err(_) => return Err(refused()),
            }
        }
        if fds[1].revents & (libc::POLLIN | libc::POLLHUP) != 0 && !local_fin && tx.empty() {
            let mut input = [0; MAX_DATA];
            match application.read(&mut input) {
                Ok(n) => {
                    let frame = if n == 0 {
                        local_fin = true;
                        Frame::Fin
                    } else {
                        Frame::Data(&input[..n])
                    };
                    tx.set(traffic.send.encode(frame)?);
                    tx_deadline = Some(Instant::now() + limits.idle_timeout);
                    stats.application_bytes_sent += n as u64;
                }
                Err(e) if retry(&e) => {}
                Err(_) => return Err(refused()),
            }
        }
        stats.peak_queued_bytes = stats.peak_queued_bytes.max(tx.remaining() + rx.remaining());
    }
}

#[cfg(test)]
#[path = "relay_client/tests.rs"]
mod tests;
