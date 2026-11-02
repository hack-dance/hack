//! Bounded single-thread handshake and streaming relay. The owner supplies current
//! graph bindings and privately provisions credentials before admitting transports.
use super::{
    host_endpoint::{HostEndpoint, PendingConnection},
    relay_auth::{Authority, AuthorizedSession, EffectGuard, RevocationWatch},
    relay_frame::{Frame, MAX_DATA},
    relay_integrity::{MAX_WIRE, Traffic},
};
use crate::CandidateError;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{Shutdown, TcpStream},
    os::{
        fd::{AsFd, AsRawFd, BorrowedFd},
        unix::net::{UnixListener, UnixStream},
    },
    time::{Duration, Instant},
};
mod admission;
use admission::Admission;

const PROBE_INTERVAL: Duration = Duration::from_millis(5);
pub(super) struct Interest<'a> {
    pub fd: BorrowedFd<'a>,
    pub events: i16,
}
fn error() -> CandidateError {
    CandidateError::new("relay_io", "Relay flow failed or closed unexpectedly.")
}

#[derive(Clone, Copy)]
pub struct Limits {
    pub max_flows: usize,
    pub connect_timeout: Duration,
    pub idle_timeout: Duration,
}
#[derive(Default, Debug)]
pub struct Stats {
    pub admitted: u64,
    pub pending_accepted: u64,
    pub peak_connections: usize,
    pub finished: u64,
    pub failed: u64,
    pub revoked: u64,
    pub timed_out: u64,
    pub cancelled: u64,
    pub peak_flows: usize,
    pub peak_queued_bytes: usize,
}
#[derive(Clone, Copy)]
enum End {
    Finished,
    Failed,
    Revoked,
    TimedOut,
    Cancelled,
}

#[derive(Default)]
struct Queue {
    bytes: Vec<u8>,
    offset: usize,
}
impl Queue {
    fn empty(&self) -> bool {
        self.offset == self.bytes.len()
    }
    fn remaining(&self) -> usize {
        self.bytes.len() - self.offset
    }
    fn set(&mut self, bytes: Vec<u8>) {
        self.bytes = bytes;
        self.offset = 0;
    }
    fn flush(
        &mut self,
        stream: &mut impl Write,
        guard: &EffectGuard,
    ) -> Result<usize, CandidateError> {
        if self.empty() {
            return Ok(0);
        }
        let wrote = guard.with_active(|| stream.write(&self.bytes[self.offset..]))?;
        match wrote {
            Ok(0) => Err(error()),
            Ok(n) => {
                self.offset += n;
                if self.empty() {
                    self.bytes.clear();
                    self.offset = 0;
                }
                Ok(n)
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) =>
            {
                Ok(0)
            }
            Err(_) => Err(error()),
        }
    }
}
struct Flow {
    id: u64,
    transport: UnixStream,
    peer: Option<TcpStream>,
    pending: Option<PendingConnection>,
    next_probe: Instant,
    guard: EffectGuard,
    watch: RevocationWatch,
    traffic: Traffic,
    to_peer: Queue,
    to_guest: Queue,
    guest_fin: bool,
    guest_eof: bool,
    peer_fin: bool,
    last_activity: Instant,
    end: Option<End>,
}
impl Flow {
    fn queued(&self) -> usize {
        self.to_peer.remaining() + self.to_guest.remaining()
    }
    fn maintain(&mut self, idle: Duration) {
        if self.last_activity.elapsed() >= idle {
            self.end = Some(End::TimedOut);
            return;
        }
        if self.pending.is_some() && Instant::now() >= self.next_probe {
            let result = self
                .pending
                .as_mut()
                .ok_or_else(error)
                .and_then(PendingConnection::progress);
            match result {
                Ok(Some(peer)) => {
                    self.peer = Some(peer);
                    self.pending = None;
                }
                Ok(None) => self.next_probe = Instant::now() + PROBE_INTERVAL,
                Err(e) => self.end = Some(classify(&e)),
            }
        }
    }
    fn events(&self) -> [libc::pollfd; 3] {
        let guest_read = self.peer.is_some() && self.to_peer.empty() && !self.guest_eof;
        let peer_read = !self.peer_fin && self.to_guest.empty();
        [
            pollfd(
                self.transport.as_raw_fd(),
                guest_read,
                !self.to_guest.empty(),
            ),
            pollfd(
                self.peer.as_ref().map_or(-1, AsRawFd::as_raw_fd),
                peer_read,
                !self.to_peer.empty(),
            ),
            pollfd(self.watch.as_fd().as_raw_fd(), true, false),
        ]
    }
    fn step(&mut self, ready: &[libc::pollfd], idle: Duration) -> Result<(), CandidateError> {
        if ready[2].revents != 0 {
            self.end = Some(End::Revoked);
            return Ok(());
        }
        self.maintain(idle);
        if self.end.is_some() || self.peer.is_none() {
            return Ok(());
        }
        if ready[..2]
            .iter()
            .any(|p| p.revents & (libc::POLLERR | libc::POLLNVAL) != 0)
        {
            return Err(error());
        }
        let mut moved = 0;
        if ready[0].revents & libc::POLLOUT != 0 {
            moved += self.to_guest.flush(&mut self.transport, &self.guard)?;
        }
        if ready[1].revents & libc::POLLOUT != 0 {
            moved += self
                .to_peer
                .flush(self.peer.as_mut().ok_or_else(error)?, &self.guard)?;
        }
        if ready[0].revents & (libc::POLLIN | libc::POLLHUP) != 0
            && self.to_peer.empty()
            && !self.guest_eof
        {
            moved += self.read_guest()?;
        }
        if ready[1].revents & (libc::POLLIN | libc::POLLHUP) != 0
            && self.to_guest.empty()
            && !self.peer_fin
        {
            moved += self.read_peer()?;
        }
        if moved > 0 {
            self.last_activity = Instant::now();
        }
        if self.guest_fin && self.peer_fin && self.to_peer.empty() && self.to_guest.empty() {
            self.end = Some(End::Finished);
        }
        Ok(())
    }
    fn read_guest(&mut self) -> Result<usize, CandidateError> {
        let limit = self.traffic.receive.read_capacity();
        if limit > MAX_WIRE {
            return Err(error());
        }
        let mut input = [0; MAX_WIRE];
        let read = match self
            .guard
            .with_active(|| self.transport.read(&mut input[..limit.max(1)]))?
        {
            Ok(0) => {
                self.traffic.receive.finish_transport()?;
                self.guest_eof = true;
                return Ok(0);
            }
            Ok(n) => n,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) =>
            {
                return Ok(0);
            }
            Err(_) => return Err(error()),
        };
        if limit == 0 {
            return Err(error());
        }
        let (used, frame) = self.traffic.receive.push(&input[..read])?;
        if used != read {
            return Err(error());
        }
        match frame {
            Some(Frame::Data(data)) => self.to_peer.set(data.to_vec()),
            Some(Frame::Fin) => {
                self.guest_fin = true;
                self.guard.with_active(|| {
                    self.peer
                        .as_ref()
                        .ok_or_else(error)?
                        .shutdown(Shutdown::Write)
                        .map_err(|_| error())
                })??;
            }
            Some(Frame::Reset) => return Err(error()),
            None => {}
        }
        Ok(read)
    }
    fn read_peer(&mut self) -> Result<usize, CandidateError> {
        let mut input = [0; MAX_DATA];
        let peer = self.peer.as_mut().ok_or_else(error)?;
        let read = match self.guard.with_active(|| peer.read(&mut input))? {
            Ok(n) => n,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) =>
            {
                return Ok(0);
            }
            Err(_) => return Err(error()),
        };
        let frame = if read == 0 {
            self.peer_fin = true;
            Frame::Fin
        } else {
            Frame::Data(&input[..read])
        };
        self.to_guest.set(self.traffic.send.encode(frame)?);
        Ok(read)
    }
}
impl Drop for Flow {
    fn drop(&mut self) {
        if matches!(self.end, Some(End::Finished)) {
            return;
        }
        if let Some(peer) = &self.peer {
            let linger = libc::linger {
                l_onoff: 1,
                l_linger: 0,
            };
            // SAFETY: this flow still owns the live TCP descriptor and linger is
            // a native option record. Abortive close prevents malformed/truncated
            // requests from becoming a normal EOF at the backend. Drop still closes
            // the descriptor if the OS refuses this best-effort cleanup option.
            let _ = unsafe {
                libc::setsockopt(
                    peer.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_LINGER,
                    (&linger as *const libc::linger).cast(),
                    std::mem::size_of_val(&linger) as libc::socklen_t,
                )
            };
        }
    }
}

fn classify(e: &CandidateError) -> End {
    match e.code {
        "relay_auth_refused" => End::Revoked,
        "host_endpoint_timeout" => End::TimedOut,
        _ => End::Failed,
    }
}
fn pollfd(fd: i32, read: bool, write: bool) -> libc::pollfd {
    let events = (if read { libc::POLLIN } else { 0 }) | (if write { libc::POLLOUT } else { 0 });
    libc::pollfd {
        fd: if events == 0 { -1 } else { fd },
        events,
        revents: 0,
    }
}

/// One owner thread calls tick; other threads may revoke shared authorities. No
/// worker is spawned per flow. Drop cancels all retained sockets and queued bytes.
pub struct RelayLoop {
    limits: Limits,
    flows: Vec<Flow>,
    handshakes: Vec<Admission>,
    next_id: u64,
    stats: Stats,
}
impl RelayLoop {
    pub fn new(limits: Limits) -> Result<Self, CandidateError> {
        if !(1..=256).contains(&limits.max_flows)
            || limits.connect_timeout.is_zero()
            || limits.connect_timeout > Duration::from_secs(5)
            || limits.idle_timeout.is_zero()
            || limits.idle_timeout > Duration::from_secs(3600)
        {
            return Err(error());
        }
        Ok(Self {
            limits,
            flows: Vec::new(),
            handshakes: Vec::new(),
            next_id: 0,
            stats: Stats::default(),
        })
    }
    pub fn active(&self) -> usize {
        self.flows.len()
    }
    /// Pending handshakes plus authenticated flows share max_flows capacity.
    pub fn connections(&self) -> usize {
        self.flows.len() + self.handshakes.len()
    }
    pub fn pending(&self) -> usize {
        self.handshakes.len()
    }
    /// Takes ownership even on refusal. The caller must bind this authority to the
    /// supplied endpoint through its current graph owner/boot/service registration.
    /// The fixed accept-to-completion budget must be positive and at most five seconds.
    /// This neither creates a listener nor changes its filesystem permissions.
    pub fn admit(
        &mut self,
        transport: UnixStream,
        endpoint: &HostEndpoint,
        authority: &Authority,
        budget: Duration,
    ) -> Result<u64, CandidateError> {
        if budget.is_zero() || budget > Duration::from_secs(5) {
            return Err(error());
        }
        self.capacity()?;
        let id = self.next_id.checked_add(1).ok_or_else(error)?;
        let pending = Admission::new(id, transport, endpoint, authority, Instant::now() + budget)?;
        self.handshakes.push(pending);
        self.next_id = id;
        self.stats.pending_accepted += 1;
        self.stats.peak_connections = self.stats.peak_connections.max(self.connections());
        Ok(id)
    }
    /// Continue a bounded owner-selected preamble without renewing its deadline.
    pub(super) fn admit_hello(
        &mut self,
        transport: UnixStream,
        endpoint: &HostEndpoint,
        authority: &Authority,
        deadline: Instant,
        hello: &[u8],
    ) -> Result<u64, CandidateError> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || remaining > Duration::from_secs(5) {
            return Err(error());
        }
        self.capacity()?;
        let id = self.next_id.checked_add(1).ok_or_else(error)?;
        let pending =
            Admission::new(id, transport, endpoint, authority, deadline)?.with_hello(hello)?;
        self.handshakes.push(pending);
        self.next_id = id;
        self.stats.pending_accepted += 1;
        self.stats.peak_connections = self.stats.peak_connections.max(self.connections());
        Ok(id)
    }
    /// Accept at most one transport without blocking, after checking shared capacity.
    /// The owner supplies a private listener and must stop polling it while full;
    /// this method neither creates nor unlinks the socket pathname.
    pub fn accept_one(
        &mut self,
        listener: &UnixListener,
        endpoint: &HostEndpoint,
        authority: &Authority,
        budget: Duration,
    ) -> Result<Option<u64>, CandidateError> {
        if budget.is_zero() || budget > Duration::from_secs(5) {
            return Err(error());
        }
        self.capacity()?;
        listener.set_nonblocking(true).map_err(|_| error())?;
        match listener.accept() {
            Ok((transport, _)) => self.admit(transport, endpoint, authority, budget).map(Some),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) =>
            {
                Ok(None)
            }
            Err(_) => Err(error()),
        }
    }
    fn capacity(&self) -> Result<(), CandidateError> {
        if self.connections() >= self.limits.max_flows {
            Err(CandidateError::new(
                "relay_capacity",
                "Relay connection capacity reached.",
            ))
        } else {
            Ok(())
        }
    }
    pub fn stats(&self) -> &Stats {
        &self.stats
    }
    /// Takes ownership of the accepted transport/session even on refusal. Caller
    /// must verify the session binding belongs to this endpoint before admission.
    pub fn add(
        &mut self,
        transport: UnixStream,
        endpoint: &HostEndpoint,
        session: AuthorizedSession,
    ) -> Result<u64, CandidateError> {
        self.capacity()?;
        let id = self.next_id.checked_add(1).ok_or_else(error)?;
        self.start_flow(id, transport, endpoint, session)?;
        self.next_id = id;
        Ok(id)
    }
    fn start_flow(
        &mut self,
        id: u64,
        transport: UnixStream,
        endpoint: &HostEndpoint,
        mut session: AuthorizedSession,
    ) -> Result<(), CandidateError> {
        transport.set_nonblocking(true).map_err(|_| error())?;
        let traffic = session.take_traffic()?;
        let watch = session.watch_revocation()?;
        let pending = endpoint.begin_connect(self.limits.connect_timeout, &session)?;
        self.flows.push(Flow {
            id,
            transport,
            peer: None,
            pending: Some(pending),
            next_probe: Instant::now(),
            guard: session.effect_guard(),
            watch,
            traffic,
            to_peer: Queue::default(),
            to_guest: Queue::default(),
            guest_fin: false,
            guest_eof: false,
            peer_fin: false,
            last_activity: Instant::now(),
            end: None,
        });
        self.stats.admitted += 1;
        self.stats.peak_flows = self.stats.peak_flows.max(self.flows.len());
        self.stats.peak_connections = self.stats.peak_connections.max(self.connections());
        Ok(())
    }
    /// Revoke first, then synchronously drop every owned socket/queue for this exact
    /// authority instance. Matching uses core identity, not a reusable binding or FD.
    /// Returns only after descriptor ownership has been released; kernel-delivered
    /// bytes and caller-retained duplicate descriptors cannot be recalled.
    pub(super) fn retire_authority(&mut self, authority: &Authority) -> usize {
        authority.revoke();
        let before = self.connections();
        for flow in &mut self.flows {
            if flow.guard.belongs_to(authority) {
                flow.end = Some(End::Revoked);
            }
        }
        self.retire();
        let pending = self.handshakes.len();
        self.handshakes.retain(|entry| !entry.belongs_to(authority));
        self.stats.revoked += (pending - self.handshakes.len()) as u64;
        before - self.connections()
    }
    pub fn cancel(&mut self, id: u64) -> bool {
        if let Some(index) = self.handshakes.iter().position(|entry| entry.id == id) {
            self.handshakes.swap_remove(index);
            self.stats.cancelled += 1;
            return true;
        }
        if let Some(flow) = self.flows.iter_mut().find(|flow| flow.id == id) {
            flow.end = Some(End::Cancelled);
            self.retire();
            true
        } else {
            false
        }
    }
    /// Blocks in poll for at most max_wait (up to 60 seconds), shortened by pending
    /// acceptance checks and idle deadlines. Each flow gets bounded work per tick.
    pub fn tick(&mut self, max_wait: Duration) -> Result<(), CandidateError> {
        self.poll_tick(max_wait, &[]).map(|_| ())
    }
    /// Include the owner's listener/control descriptor so new work can wake an
    /// otherwise idle loop. True means owner readiness; caller drains/handles it.
    /// The borrowed descriptor stays valid for this call and is never read here.
    pub fn tick_with_wakeup(
        &mut self,
        max_wait: Duration,
        wake: BorrowedFd<'_>,
    ) -> Result<bool, CandidateError> {
        self.poll_tick(
            max_wait,
            &[Interest {
                fd: wake,
                events: libc::POLLIN,
            }],
        )
        .map(|ready| ready[0] != 0)
    }
    pub(super) fn poll_tick(
        &mut self,
        max_wait: Duration,
        external: &[Interest<'_>],
    ) -> Result<Vec<i16>, CandidateError> {
        if max_wait > Duration::from_secs(60)
            || external.len() > 65
            || external
                .iter()
                .any(|i| i.events == 0 || i.events & !(libc::POLLIN | libc::POLLOUT) != 0)
        {
            return Err(error());
        }
        for flow in &mut self.flows {
            flow.maintain(self.limits.idle_timeout);
        }
        for entry in &mut self.handshakes {
            entry.maintain();
        }
        self.retire_admissions();
        self.retire();
        if self.connections() == 0 && external.is_empty() {
            return Ok(Vec::new());
        }
        let now = Instant::now();
        let mut wait = max_wait;
        let specs: Vec<_> = self.flows.iter().map(Flow::events).collect();
        let mut interests = BTreeMap::<i32, i16>::new();
        let pending_specs: Vec<_> = self.handshakes.iter().map(Admission::events).collect();
        for spec in specs
            .iter()
            .map(|s| &s[..])
            .chain(pending_specs.iter().map(|s| &s[..]))
        {
            for fd in spec {
                if fd.fd >= 0 {
                    *interests.entry(fd.fd).or_default() |= fd.events;
                }
            }
        }
        for flow in &self.flows {
            wait = wait.min(
                (flow.last_activity + self.limits.idle_timeout).saturating_duration_since(now),
            );
            if flow.pending.is_some() {
                wait = wait.min(flow.next_probe.saturating_duration_since(now));
            }
        }
        for entry in &self.handshakes {
            wait = wait.min(entry.deadline.saturating_duration_since(now));
        }
        for interest in external {
            *interests.entry(interest.fd.as_raw_fd()).or_default() |= interest.events;
        }
        // Darwin poll reports only one entry for repeated descriptors. Register
        // each descriptor once, then fan readiness out to every associated flow.
        let mut events: Vec<_> = interests
            .into_iter()
            .map(|(fd, events)| libc::pollfd {
                fd,
                events,
                revents: 0,
            })
            .collect();
        let milliseconds = wait.as_nanos().div_ceil(1_000_000).min(i32::MAX as u128) as i32;
        // SAFETY: events owns initialized records for live flow/watch descriptors,
        // retained for the complete call; poll retains no pointers.
        let result = unsafe {
            libc::poll(
                events.as_mut_ptr(),
                events.len() as libc::nfds_t,
                milliseconds,
            )
        };
        if result < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                return Ok(vec![0; external.len()]);
            }
            self.stats.failed += self.connections() as u64;
            self.handshakes.clear();
            self.flows.clear();
            return Err(error());
        }
        let ready: BTreeMap<_, _> = events.iter().map(|fd| (fd.fd, fd.revents)).collect();
        for (flow, mut spec) in self.flows.iter_mut().zip(specs) {
            for fd in &mut spec {
                fd.revents = ready.get(&fd.fd).copied().unwrap_or(0);
            }
            if let Err(e) = flow.step(&spec, self.limits.idle_timeout) {
                flow.end = Some(classify(&e));
            }
        }
        for (entry, mut spec) in self.handshakes.iter_mut().zip(pending_specs) {
            for fd in &mut spec {
                fd.revents = ready.get(&fd.fd).copied().unwrap_or(0);
            }
            if let Err(e) = entry.step(&spec) {
                entry.end = Some(if entry.authority_revoked() {
                    End::Revoked
                } else if e.code == "relay_handshake_timeout" {
                    End::TimedOut
                } else {
                    End::Failed
                });
            }
        }
        self.retire_admissions();
        self.stats.peak_queued_bytes = self
            .stats
            .peak_queued_bytes
            .max(self.flows.iter().map(Flow::queued).sum());
        self.retire();
        Ok(external
            .iter()
            .map(|interest| {
                ready.get(&interest.fd.as_raw_fd()).copied().unwrap_or(0)
                    & (interest.events | libc::POLLERR | libc::POLLHUP | libc::POLLNVAL)
            })
            .collect())
    }
    fn retire_admissions(&mut self) {
        let mut index = 0;
        while index < self.handshakes.len() {
            if self.handshakes[index].end.is_none() && !self.handshakes[index].ready() {
                index += 1;
                continue;
            }
            let mut entry = self.handshakes.swap_remove(index);
            match entry.end {
                Some(End::TimedOut) => self.stats.timed_out += 1,
                Some(End::Revoked) => self.stats.revoked += 1,
                Some(_) => self.stats.failed += 1,
                None if entry.ready() => {
                    let result = entry.session.take().ok_or_else(error).and_then(|session| {
                        self.start_flow(entry.id, entry.transport, &entry.endpoint, session)
                    });
                    if let Err(e) = result {
                        match classify(&e) {
                            End::Revoked => self.stats.revoked += 1,
                            End::TimedOut => self.stats.timed_out += 1,
                            _ => self.stats.failed += 1,
                        }
                    }
                }
                None => unreachable!("only terminal or ready admissions are removed"),
            }
        }
    }
    fn retire(&mut self) {
        for flow in &self.flows {
            match flow.end {
                Some(End::Finished) => self.stats.finished += 1,
                Some(End::Failed) => self.stats.failed += 1,
                Some(End::Revoked) => self.stats.revoked += 1,
                Some(End::TimedOut) => self.stats.timed_out += 1,
                Some(End::Cancelled) => self.stats.cancelled += 1,
                None => {}
            }
        }
        self.flows.retain(|flow| flow.end.is_none());
    }
}
#[cfg(test)]
mod tests;

#[cfg(test)]
mod admission_tests;
