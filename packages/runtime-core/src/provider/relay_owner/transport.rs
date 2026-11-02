//! One bounded graph control exchange on an already connected, exclusively owned socket.
//! The caller must verify private path/receipt ownership before connecting, cap concurrent
//! exchanges, and poll each interest no later than its deadline. No threads or timers spawn.
use super::{
    Acknowledgement, GraphSelection, RelayOwner, RetireRequest, SelectionRequest, control, refused,
};
use crate::{
    CandidateError,
    provider::identity::{self, ProcessIdentity},
};
use std::{
    io::{Read, Write},
    net::Shutdown,
    os::{
        fd::{AsFd, AsRawFd, BorrowedFd},
        unix::net::UnixStream,
    },
    time::{Duration, Instant},
};

const CHUNK: usize = 8192;

/// Native same-user identity for an accepted private socket, never request JSON.
/// The local user is the authority boundary; this is not a per-client capability.
pub(super) fn observe_peer(stream: &UnixStream) -> Result<ProcessIdentity, CandidateError> {
    let mut uid = 0;
    let mut gid = 0;
    let mut pid: libc::pid_t = 0;
    let mut length = std::mem::size_of_val(&pid) as libc::socklen_t;
    // SAFETY: all pointers refer to initialized, correctly sized writable local values;
    // the borrowed stream keeps its descriptor alive through these synchronous calls.
    let valid = unsafe {
        libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) == 0
            && uid == libc::geteuid()
            && libc::getsockopt(
                stream.as_raw_fd(),
                0,
                libc::LOCAL_PEERPID,
                (&mut pid as *mut libc::pid_t).cast(),
                &mut length,
            ) == 0
    };
    if !valid || length as usize != std::mem::size_of_val(&pid) {
        return Err(refused());
    }
    let observed = identity::observe(pid).map_err(|_| refused())?;
    identity::verify(&observed, &observed, &observed.executable, uid).map_err(|_| refused())?;
    Ok(observed)
}
/// Kernel-connected peer must match trusted native identity, not a PID from the request.
/// This does not protect against the authorized process deliberately passing its socket.
fn verify_peer(stream: &UnixStream, expected: &ProcessIdentity) -> Result<(), CandidateError> {
    let observed = observe_peer(stream)?;
    identity::verify(expected, &observed, &expected.executable, observed.uid).map_err(|_| refused())
}

struct Wire {
    stream: Option<UnixStream>,
    peer: ProcessIdentity,
    deadline: Instant,
    prefix: [u8; 4],
    prefix_used: usize,
    body: Vec<u8>,
    length: Option<usize>,
    limit: usize,
    output: Vec<u8>,
    written: usize,
    sending: bool,
}
impl Wire {
    fn new(
        stream: UnixStream,
        peer: &ProcessIdentity,
        budget: Duration,
        limit: usize,
    ) -> Result<Self, CandidateError> {
        if budget.is_zero() || budget > Duration::from_secs(5) {
            return Err(refused());
        }
        let deadline = Instant::now() + budget;
        verify_peer(&stream, peer)?;
        stream.set_nonblocking(true).map_err(|_| refused())?;
        Ok(Self {
            stream: Some(stream),
            peer: peer.clone(),
            deadline,
            prefix: [0; 4],
            prefix_used: 0,
            body: Vec::new(),
            length: None,
            limit,
            output: Vec::new(),
            written: 0,
            sending: false,
        })
    }
    fn interest(&self) -> Option<(BorrowedFd<'_>, i16)> {
        self.stream.as_ref().map(|s| {
            (
                s.as_fd(),
                if self.sending {
                    libc::POLLOUT
                } else {
                    libc::POLLIN
                },
            )
        })
    }
    fn check(&self) -> Result<(), CandidateError> {
        if self.stream.is_none() || Instant::now() >= self.deadline {
            Err(refused())
        } else {
            Ok(())
        }
    }
    fn close(&mut self) {
        self.stream.take();
    }
    fn queue(&mut self, bytes: Vec<u8>) {
        self.output = Vec::with_capacity(bytes.len() + 4);
        self.output
            .extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        self.output.extend_from_slice(&bytes);
        self.sending = true;
    }
    /// At most one nonblocking write per turn. EOF delimits the sole message.
    fn write(&mut self) -> Result<bool, CandidateError> {
        self.check()?;
        if self.written == 0 {
            verify_peer(self.stream.as_ref().ok_or_else(refused)?, &self.peer)?;
        }
        self.check()?;
        let stream = self.stream.as_mut().ok_or_else(refused)?;
        let end = (self.written + CHUNK).min(self.output.len());
        match stream.write(&self.output[self.written..end]) {
            Ok(0) => return Err(refused()),
            Ok(n) => self.written += n,
            Err(e) if retryable(&e) => return Ok(false),
            Err(_) => return Err(refused()),
        }
        if self.written != self.output.len() {
            return Ok(false);
        }
        stream.shutdown(Shutdown::Write).map_err(|_| refused())?;
        self.output.clear();
        self.sending = false;
        Ok(true)
    }
    /// At most one nonblocking read per turn, with no body allocation until a valid
    /// bounded length is known. Require EOF so a suffix cannot mutate owner state.
    fn read(&mut self) -> Result<bool, CandidateError> {
        self.check()?;
        let stream = self.stream.as_mut().ok_or_else(refused)?;
        if self.prefix_used < 4 {
            match stream.read(&mut self.prefix[self.prefix_used..]) {
                Ok(0) => return Err(refused()),
                Ok(n) => self.prefix_used += n,
                Err(e) if retryable(&e) => return Ok(false),
                Err(_) => return Err(refused()),
            }
            if self.prefix_used == 4 {
                let length = u32::from_be_bytes(self.prefix) as usize;
                if length == 0 || length > self.limit {
                    return Err(refused());
                }
                self.length = Some(length);
                self.body.reserve_exact(length);
            }
            return Ok(false);
        }
        let remaining = self.length.ok_or_else(refused)? - self.body.len();
        let mut bytes = [0; CHUNK];
        // One extra byte only when the declared body is complete detects suffixes.
        let take = remaining.clamp(1, CHUNK);
        match stream.read(&mut bytes[..take]) {
            Ok(0) => {
                if remaining == 0 {
                    Ok(true)
                } else {
                    Err(refused())
                }
            }
            Ok(_) if remaining == 0 => Err(refused()),
            Ok(n) => {
                self.body.extend_from_slice(&bytes[..n]);
                Ok(false)
            }
            Err(e) if retryable(&e) => Ok(false),
            Err(_) => Err(refused()),
        }
    }
}
fn retryable(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
    )
}

/// One selection or retirement request. Retirement occurs once, before reply bytes;
/// failure to deliver the reply does not undo fencing. Errors close the owned socket.
pub struct ServerExchange {
    wire: Wire,
    responded: bool,
}
impl ServerExchange {
    pub fn new(
        stream: UnixStream,
        coordinator: &ProcessIdentity,
        budget: Duration,
    ) -> Result<Self, CandidateError> {
        Ok(Self {
            wire: Wire::new(stream, coordinator, budget, control::REQUEST_LIMIT)?,
            responded: false,
        })
    }
    pub fn interest(&self) -> Option<(BorrowedFd<'_>, i16)> {
        self.wire.interest()
    }
    pub fn deadline(&self) -> Instant {
        self.wire.deadline
    }
    /// True means response delivery completed. Remove completed/failed exchanges.
    pub fn progress(&mut self, owner: &mut RelayOwner) -> Result<bool, CandidateError> {
        let result = self.advance(owner);
        if !matches!(result, Ok(false)) {
            self.wire.close();
        }
        result
    }
    fn advance(&mut self, owner: &mut RelayOwner) -> Result<bool, CandidateError> {
        if self.responded {
            return self.wire.write();
        }
        if !self.wire.read()? {
            return Ok(false);
        }
        verify_peer(
            self.wire.stream.as_ref().ok_or_else(refused)?,
            &self.wire.peer,
        )?;
        self.wire.check()?;
        let response = match SelectionRequest::parse(&self.wire.body) {
            Ok(request) => GraphSelection::for_owner(owner, request)?.encode()?,
            Err(_) => owner
                .retire(&RetireRequest::parse(&self.wire.body)?)?
                .encode()?,
        };
        self.responded = true;
        self.wire.body.clear();
        self.wire.queue(response);
        Ok(false)
    }
}

/// Pins the owner process before sending a non-secret request; verifies the complete
/// reply against its owner incarnation, operation and target digest before success.
pub struct ClientExchange {
    wire: Wire,
    request: RetireRequest,
}
impl ClientExchange {
    pub fn new(
        stream: UnixStream,
        owner: &ProcessIdentity,
        request: RetireRequest,
        budget: Duration,
    ) -> Result<Self, CandidateError> {
        let bytes = request.encode()?;
        let mut wire = Wire::new(stream, owner, budget, control::ACK_LIMIT)?;
        wire.queue(bytes);
        Ok(Self { wire, request })
    }
    pub fn interest(&self) -> Option<(BorrowedFd<'_>, i16)> {
        self.wire.interest()
    }
    pub fn deadline(&self) -> Instant {
        self.wire.deadline
    }
    pub fn progress(&mut self) -> Result<Option<Acknowledgement>, CandidateError> {
        let result = self.advance();
        if !matches!(result, Ok(None)) {
            self.wire.close();
        }
        result
    }
    fn advance(&mut self) -> Result<Option<Acknowledgement>, CandidateError> {
        if self.wire.sending {
            self.wire.write()?;
            return Ok(None);
        }
        if !self.wire.read()? {
            return Ok(None);
        }
        Acknowledgement::verify(&self.wire.body, &self.request).map(Some)
    }
}

#[cfg(test)]
mod tests;

/// A native-authenticated graph selection with the same fixed deadline and EOF
/// rules as retirement. The result observes membership but grants no effect authority.
pub struct SelectionExchange {
    wire: Wire,
    request: SelectionRequest,
}
impl SelectionExchange {
    pub fn new(
        stream: UnixStream,
        owner: &ProcessIdentity,
        request: SelectionRequest,
        budget: Duration,
    ) -> Result<Self, CandidateError> {
        let bytes = request.encode()?;
        let mut wire = Wire::new(stream, owner, budget, control::REQUEST_LIMIT)?;
        wire.queue(bytes);
        Ok(Self { wire, request })
    }
    pub fn interest(&self) -> Option<(BorrowedFd<'_>, i16)> {
        self.wire.interest()
    }
    pub fn deadline(&self) -> Instant {
        self.wire.deadline
    }
    pub fn progress(&mut self) -> Result<Option<GraphSelection>, CandidateError> {
        let result = self.advance();
        if !matches!(result, Ok(None)) {
            self.wire.close();
        }
        result
    }
    fn advance(&mut self) -> Result<Option<GraphSelection>, CandidateError> {
        if self.wire.sending {
            self.wire.write()?;
            return Ok(None);
        }
        if !self.wire.read()? {
            return Ok(None);
        }
        GraphSelection::verify(&self.wire.body, &self.request).map(Some)
    }
}

#[cfg(test)]
mod selection_tests;
