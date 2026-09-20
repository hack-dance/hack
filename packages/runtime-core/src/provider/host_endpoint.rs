//! Pin an explicit host process and listener before releasing a payload-capable stream.
//!
//! This primitive does not register a graph/VM owner or authorize an application alias.
//! Native identity protects against endpoint replacement, not a malicious authorized peer.
use super::relay_auth::AuthorizedSession;
use crate::CandidateError;
use std::{net::TcpStream, time::Duration};

fn refused() -> CandidateError {
    CandidateError::new(
        "host_endpoint_identity",
        "The exclusive loopback listener or accepted connection cannot be verified.",
    )
}

/// An in-memory observation of one explicit same-UID process's exclusive IPv4 listener.
/// Capture does not adopt a process, signal it, or create durable owner authorization.
#[derive(Debug, Clone)]
pub struct HostEndpoint {
    #[cfg(target_os = "macos")]
    process: super::identity::ProcessIdentity,
    #[cfg(target_os = "macos")]
    listener: NativeIdentity,
    #[cfg(target_os = "macos")]
    port: u16,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, Default)]
#[repr(C)]
struct NativeIdentity {
    generation: u64,
    descriptor: i32,
    accepted: i32,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn hack_loopback_inspect(
        pid: i32,
        port: u16,
        peer_port: u16,
        result: *mut NativeIdentity,
    ) -> i32;
}

impl HostEndpoint {
    /// Review identity for an explicit dependency selection. Revalidates the native
    /// listener; a later capture must match before issuing any capability.
    pub fn fingerprint(&self) -> Result<String, CandidateError> {
        #[cfg(target_os = "macos")]
        {
            Ok(self
                .generation()?
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect())
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(refused())
        }
    }
    /// Identity fingerprint for a capability grant, after rechecking the live listener.
    #[cfg(target_os = "macos")]
    pub(super) fn generation(&self) -> Result<[u8; 32], CandidateError> {
        use sha2::{Digest, Sha256};
        self.verify(0)?;
        let bytes = serde_json::to_vec(&serde_json::json!([
            "hack-host-endpoint-v1",
            self.process,
            self.port,
            self.listener.descriptor,
            self.listener.generation
        ]))
        .map_err(|_| refused())?;
        Ok(Sha256::digest(bytes).into())
    }

    /// Refuse wildcard/shared listeners, ambiguous snapshots and unavailable native evidence.
    pub fn capture(pid: i32, port: u16) -> Result<Self, CandidateError> {
        #[cfg(target_os = "macos")]
        {
            let process = super::identity::observe(pid)?;
            super::identity::verify(
                &process,
                &process,
                &process.executable,
                // SAFETY: geteuid has no pointer arguments.
                unsafe { libc::geteuid() },
            )?;
            let listener = inspect(pid, port, 0)?;
            let endpoint = Self {
                process,
                listener,
                port,
            };
            endpoint.verify(0)?;
            Ok(endpoint)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (pid, port);
            Err(CandidateError::new(
                "unsupported_host",
                "Native host endpoint identity requires macOS.",
            ))
        }
    }

    /// Start an authenticated nonblocking connection without returning a usable stream.
    /// The owning reactor must cap pending connections, schedule progress checks and
    /// wake/drop them on revocation. This call does bounded native identity inspection.
    pub fn begin_connect(
        &self,
        budget: Duration,
        session: &AuthorizedSession,
    ) -> Result<PendingConnection, CandidateError> {
        if budget.is_zero() || budget > Duration::from_secs(5) {
            return Err(refused());
        }
        #[cfg(target_os = "macos")]
        {
            let deadline = std::time::Instant::now() + budget;
            self.verify(0)?;
            let guard = session.effect_guard();
            let stream = pending::connect(self.port, deadline, &guard)?;
            Ok(PendingConnection {
                endpoint: self.clone(),
                stream: Some(stream),
                deadline,
                guard,
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = session;
            Err(CandidateError::new(
                "unsupported_host",
                "Native host endpoint identity requires macOS.",
            ))
        }
    }

    /// Return only after the intended process accepted this exact TCP connection.
    /// No application bytes are sent during validation. A non-accepting server times out.
    /// The total connection/acceptance budget must be positive and at most five seconds.
    pub fn connect(&self, budget: Duration) -> Result<TcpStream, CandidateError> {
        self.connect_after_check(budget, || {})
    }

    fn connect_after_check(
        &self,
        budget: Duration,
        after_check: impl FnOnce(),
    ) -> Result<TcpStream, CandidateError> {
        if budget.is_zero() || budget > Duration::from_secs(5) {
            return Err(refused());
        }
        #[cfg(target_os = "macos")]
        {
            use std::{
                net::{Ipv4Addr, SocketAddr},
                thread,
                time::Instant,
            };
            let deadline = Instant::now() + budget;
            self.verify(0)?;
            after_check();
            let stream = TcpStream::connect_timeout(
                &SocketAddr::from((Ipv4Addr::LOCALHOST, self.port)),
                deadline
                    .checked_duration_since(Instant::now())
                    .ok_or_else(timeout)?,
            )
            .map_err(|_| refused())?;
            let peer_port = stream.local_addr().map_err(|_| refused())?.port();
            loop {
                let accepted = self.verify(peer_port)?;
                if accepted {
                    // The first scan can see the old listener then a newly accepted peer.
                    // Rechecking the listener closes that scan-time close/rebind window.
                    self.verify(0)?;
                    if Instant::now() >= deadline {
                        return Err(timeout());
                    }
                    return Ok(stream);
                }
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .ok_or_else(timeout)?;
                thread::sleep(remaining.min(Duration::from_millis(5)));
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = after_check;
            Err(CandidateError::new(
                "unsupported_host",
                "Native host endpoint identity requires macOS.",
            ))
        }
    }

    #[cfg(target_os = "macos")]
    fn verify(&self, peer_port: u16) -> Result<bool, CandidateError> {
        let current = inspect(self.process.pid, self.port, peer_port)?;
        super::identity::verify(
            &self.process,
            &super::identity::observe(self.process.pid)?,
            &self.process.executable,
            // SAFETY: geteuid takes no pointers and observes the calling process.
            unsafe { libc::geteuid() },
        )?;
        if current.descriptor != self.listener.descriptor
            || current.generation != self.listener.generation
        {
            return Err(refused());
        }
        Ok(current.accepted == 1)
    }
}

/// Owns a socket that cannot carry caller payload until the intended peer is verified.
/// Drop cancels it. No background task, thread or polling loop is spawned.
pub struct PendingConnection {
    #[cfg(target_os = "macos")]
    endpoint: HostEndpoint,
    #[cfg(target_os = "macos")]
    stream: Option<TcpStream>,
    #[cfg(target_os = "macos")]
    deadline: std::time::Instant,
    #[cfg(target_os = "macos")]
    guard: super::relay_auth::EffectGuard,
}
impl PendingConnection {
    /// One nonblocking progress check. None means the intended process has not yet
    /// accepted; Some yields a nonblocking stream. Errors and success are terminal.
    /// This guards admission only: every subsequent effect still needs with_active.
    pub fn progress(&mut self) -> Result<Option<TcpStream>, CandidateError> {
        #[cfg(target_os = "macos")]
        {
            match self.ready() {
                Ok(false) => Ok(None),
                Ok(true) => self
                    .guard
                    .with_active(|| {
                        if std::time::Instant::now() >= self.deadline {
                            Err(timeout())
                        } else {
                            self.stream.take().map(Some).ok_or_else(refused)
                        }
                    })
                    .and_then(|value| value),
                Err(error) => {
                    self.stream.take();
                    Err(error)
                }
            }
            .inspect_err(|_| {
                self.stream.take();
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(CandidateError::new(
                "unsupported_host",
                "Native host endpoint identity requires macOS.",
            ))
        }
    }
    #[cfg(target_os = "macos")]
    fn ready(&self) -> Result<bool, CandidateError> {
        self.guard.with_active(|| ())?;
        if std::time::Instant::now() >= self.deadline {
            return Err(timeout());
        }
        let stream = self.stream.as_ref().ok_or_else(refused)?;
        if stream.take_error().map_err(|_| refused())?.is_some() {
            return Err(refused());
        }
        match stream.peer_addr() {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotConnected => {
                self.endpoint.verify(0)?;
                return Ok(false);
            }
            Err(_) => return Err(refused()),
        }
        let peer_port = stream.local_addr().map_err(|_| refused())?.port();
        if !self.endpoint.verify(peer_port)? {
            return Ok(false);
        }
        self.endpoint.verify(0)?;
        if std::time::Instant::now() >= self.deadline {
            return Err(timeout());
        }
        Ok(true)
    }
}

#[cfg(target_os = "macos")]
mod pending;

#[cfg(target_os = "macos")]
fn timeout() -> CandidateError {
    CandidateError::new(
        "host_endpoint_timeout",
        "The intended host process did not accept within the connection budget.",
    )
}

#[cfg(target_os = "macos")]
fn inspect(pid: i32, port: u16, peer_port: u16) -> Result<NativeIdentity, CandidateError> {
    let mut result = NativeIdentity::default();
    // SAFETY: the SDK-compiled C function receives a writable fixed-width repr(C)
    // record of the matching layout; it retains no pointer and enumerates at most 4096 FDs.
    if unsafe { hack_loopback_inspect(pid, port, peer_port, &mut result) } != 0 {
        return Err(refused());
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
