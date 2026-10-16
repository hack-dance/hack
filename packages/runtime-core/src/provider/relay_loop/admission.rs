//! Fixed-size handshake state; never connects upstream before proof and acceptance.
use super::*;
use crate::provider::relay_auth::{Authority, CLIENT_HELLO_BYTES, ServerHandshake};

#[derive(Clone, Copy)]
enum Stage {
    Hello,
    Challenge,
    Proof,
    Acceptance,
    Ready,
}
pub(super) struct Admission {
    pub id: u64,
    pub transport: UnixStream,
    pub endpoint: HostEndpoint,
    authority: Authority,
    guard: EffectGuard,
    watch: RevocationWatch,
    pub deadline: Instant,
    stage: Stage,
    input: [u8; CLIENT_HELLO_BYTES],
    output: [u8; 64],
    used: usize,
    server: Option<ServerHandshake>,
    pub session: Option<AuthorizedSession>,
    pub end: Option<End>,
}
impl Admission {
    pub fn new(
        id: u64,
        transport: UnixStream,
        endpoint: &HostEndpoint,
        authority: &Authority,
        deadline: Instant,
    ) -> Result<Self, CandidateError> {
        transport.set_nonblocking(true).map_err(|_| error())?;
        Ok(Self {
            id,
            transport,
            endpoint: endpoint.clone(),
            authority: authority.clone(),
            guard: authority.effect_guard(),
            watch: authority.watch_revocation()?,
            deadline,
            stage: Stage::Hello,
            input: [0; CLIENT_HELLO_BYTES],
            output: [0; 64],
            used: 0,
            server: None,
            session: None,
            end: None,
        })
    }
    pub fn events(&self) -> [libc::pollfd; 2] {
        let read = matches!(self.stage, Stage::Hello | Stage::Proof);
        [
            pollfd(self.transport.as_raw_fd(), read, !read),
            pollfd(self.watch.as_fd().as_raw_fd(), true, false),
        ]
    }
    pub fn belongs_to(&self, authority: &Authority) -> bool {
        self.guard.belongs_to(authority)
    }
    pub fn authority_revoked(&self) -> bool {
        self.watch.is_revoked().unwrap_or(true)
    }
    pub fn ready(&self) -> bool {
        matches!(self.stage, Stage::Ready)
    }
    pub fn maintain(&mut self) {
        if Instant::now() >= self.deadline {
            self.end = Some(End::TimedOut);
        }
    }
    pub fn step(&mut self, ready: &[libc::pollfd]) -> Result<(), CandidateError> {
        self.maintain();
        if self.end.is_some() {
            return Ok(());
        }
        if ready[1].revents != 0 {
            self.end = Some(End::Revoked);
            return Ok(());
        }
        if ready[0].revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
            return Err(error());
        }
        let reading = matches!(self.stage, Stage::Hello | Stage::Proof);
        let interest = if reading {
            libc::POLLIN | libc::POLLHUP
        } else {
            libc::POLLOUT | libc::POLLHUP
        };
        if ready[0].revents & interest == 0 {
            return Ok(());
        }
        let length = match self.stage {
            Stage::Hello => CLIENT_HELLO_BYTES,
            Stage::Challenge => 64,
            Stage::Proof | Stage::Acceptance => 32,
            Stage::Ready => return Ok(()),
        };
        let result = self.guard.with_active(|| {
            if Instant::now() >= self.deadline {
                return Err(CandidateError::new(
                    "relay_handshake_timeout",
                    "Relay handshake expired.",
                ));
            }
            Ok(if reading {
                self.transport.read(&mut self.input[self.used..length])
            } else {
                self.transport.write(&self.output[self.used..length])
            })
        })??;
        match result {
            Ok(0) => return Err(error()),
            Ok(n) => self.used += n,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) =>
            {
                return Ok(());
            }
            Err(_) => return Err(error()),
        }
        if self.used != length {
            return Ok(());
        }
        self.used = 0;
        self.stage = match self.stage {
            Stage::Hello => {
                let (server, challenge) = self.authority.challenge(&self.input)?;
                self.server = Some(server);
                self.output = challenge;
                Stage::Challenge
            }
            Stage::Challenge => Stage::Proof,
            Stage::Proof => {
                let (session, acceptance) = self
                    .server
                    .take()
                    .ok_or_else(error)?
                    .finish(&self.input[..32])?;
                self.session = Some(session);
                self.output[..32].copy_from_slice(&acceptance);
                Stage::Acceptance
            }
            Stage::Acceptance => Stage::Ready,
            Stage::Ready => return Err(error()),
        };
        self.maintain();
        Ok(())
    }
}
