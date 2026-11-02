//! Mutual capability proofs and revocable effect admission, not a complete tunnel.
//! Callers own private provisioning, socket admission, lifecycle registration and transport integration.
use super::relay_integrity::Traffic;
use crate::CandidateError;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::{
    fs::File,
    io::Read,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const MAGIC: &[u8; 8] = b"HKRA0001";
const DOMAIN: &[u8] = b"Hack relay auth v1\0";
const TTL: Duration = Duration::from_secs(5);
pub const CLIENT_HELLO_BYTES: usize = 136;
/// Logical grants are independent of the physical provider socket budget.
pub const MAX_LOGICAL_BINDINGS: usize = 128;
pub const SERVER_HELLO_BYTES: usize = 64;
type HmacSha256 = Hmac<Sha256>;
#[path = "relay_auth/provision.rs"]
mod provision;
#[path = "relay_auth/revocation.rs"]
mod revocation;
pub use provision::PrivateInput;
pub use revocation::RevocationWatch;

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Binding {
    pub owner: [u8; 16],
    pub boot: [u8; 16],
    pub endpoint: [u8; 32],
    pub service: [u8; 32],
}
impl Binding {
    fn bytes(self) -> [u8; 96] {
        let mut bytes = [0; 96];
        bytes[..16].copy_from_slice(&self.owner);
        bytes[16..32].copy_from_slice(&self.boot);
        bytes[32..64].copy_from_slice(&self.endpoint);
        bytes[64..].copy_from_slice(&self.service);
        bytes
    }
    fn valid(self) -> bool {
        [
            &self.owner[..],
            &self.boot[..],
            &self.endpoint[..],
            &self.service[..],
        ]
        .iter()
        .all(|part| part.iter().any(|byte| *byte != 0))
    }
}
fn refused() -> CandidateError {
    CandidateError::new(
        "relay_auth_refused",
        "Relay authorization is invalid, expired or revoked.",
    )
}
fn nonce() -> Result<[u8; 32], CandidateError> {
    let mut bytes = [0; 32];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|_| refused())?;
    Ok(bytes)
}
fn mac(
    key: &[u8],
    role: u8,
    binding: Binding,
    client: &[u8; 32],
    server: &[u8; 32],
) -> Result<HmacSha256, CandidateError> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| refused())?;
    mac.update(DOMAIN);
    mac.update(&[role]);
    mac.update(&binding.bytes());
    mac.update(client);
    mac.update(server);
    Ok(mac)
}
fn tag(mac: HmacSha256) -> [u8; 32] {
    mac.finalize().into_bytes().into()
}
fn fresh(deadline: Instant) -> Result<(), CandidateError> {
    if Instant::now() < deadline {
        Ok(())
    } else {
        Err(refused())
    }
}

/// No Debug/Serialize or raw-key getter. Provision the same random key privately on
/// both endpoints; this type does not establish the provenance of a caller's input.
pub struct Credential {
    binding: Binding,
    key: Zeroizing<[u8; 32]>,
}
impl Credential {
    pub fn generate(binding: Binding) -> Result<Self, CandidateError> {
        Self::from_private_input(binding, nonce()?)
    }
    pub fn from_private_input(binding: Binding, key: [u8; 32]) -> Result<Self, CandidateError> {
        let key = Zeroizing::new(key);
        if !binding.valid() || key.iter().all(|byte| *byte == 0) {
            return Err(refused());
        }
        Ok(Self { binding, key })
    }
    pub fn begin(&self) -> Result<(ClientHandshake<'_>, [u8; CLIENT_HELLO_BYTES]), CandidateError> {
        let client = nonce()?;
        let mut hello = [0; CLIENT_HELLO_BYTES];
        hello[..8].copy_from_slice(MAGIC);
        hello[8..104].copy_from_slice(&self.binding.bytes());
        hello[104..].copy_from_slice(&client);
        Ok((
            ClientHandshake {
                credential: self,
                client,
                deadline: Instant::now() + TTL,
            },
            hello,
        ))
    }
}
pub struct ClientHandshake<'a> {
    credential: &'a Credential,
    client: [u8; 32],
    deadline: Instant,
}
pub struct ClientFinish<'a> {
    credential: &'a Credential,
    client: [u8; 32],
    server: [u8; 32],
    deadline: Instant,
}
/// Proof of the server's final acceptance, not permission to bypass later revocation.
pub struct ClientAccepted {
    traffic: Traffic,
}
impl ClientAccepted {
    pub fn into_traffic(self) -> Traffic {
        self.traffic
    }
}
// Fixed-length transcript, distinct domain and direction labels. These keys are
// released only after proof verification; neither handshake role tags nor keys
// from another nonce pair can authenticate records in this session.
fn traffic(
    key: &[u8],
    binding: Binding,
    client: &[u8; 32],
    server: &[u8; 32],
    client_side: bool,
) -> Result<Traffic, CandidateError> {
    let derive = |direction: u8| -> Result<Zeroizing<[u8; 32]>, CandidateError> {
        let mut value = HmacSha256::new_from_slice(key).map_err(|_| refused())?;
        value.update(b"Hack relay traffic v1\0");
        value.update(&[direction]);
        value.update(&binding.bytes());
        value.update(client);
        value.update(server);
        Ok(Zeroizing::new(tag(value)))
    };
    let c2s = derive(b'C')?;
    let s2c = derive(b'S')?;
    Ok(if client_side {
        Traffic::new(c2s, s2c)
    } else {
        Traffic::new(s2c, c2s)
    })
}
impl<'a> ClientHandshake<'a> {
    pub fn answer(self, hello: &[u8]) -> Result<(ClientFinish<'a>, [u8; 32]), CandidateError> {
        fresh(self.deadline)?;
        if hello.len() != SERVER_HELLO_BYTES {
            return Err(refused());
        }
        let mut server = [0; 32];
        server.copy_from_slice(&hello[..32]);
        mac(
            &self.credential.key[..],
            b'S',
            self.credential.binding,
            &self.client,
            &server,
        )?
        .verify_slice(&hello[32..])
        .map_err(|_| refused())?;
        let proof = tag(mac(
            &self.credential.key[..],
            b'C',
            self.credential.binding,
            &self.client,
            &server,
        )?);
        Ok((
            ClientFinish {
                credential: self.credential,
                client: self.client,
                server,
                deadline: self.deadline,
            },
            proof,
        ))
    }
}
impl ClientFinish<'_> {
    pub fn accept(self, proof: &[u8]) -> Result<ClientAccepted, CandidateError> {
        fresh(self.deadline)?;
        mac(
            &self.credential.key[..],
            b'A',
            self.credential.binding,
            &self.client,
            &self.server,
        )?
        .verify_slice(proof)
        .map_err(|_| refused())?;
        Ok(ClientAccepted {
            traffic: traffic(
                &self.credential.key[..],
                self.credential.binding,
                &self.client,
                &self.server,
                true,
            )?,
        })
    }
}
struct Core {
    binding: Binding,
    key: Mutex<Option<Zeroizing<[u8; 32]>>>,
    signal: Mutex<Option<revocation::Signal>>,
}
#[derive(Clone)]
pub struct Authority {
    core: Arc<Core>,
}
impl Authority {
    #[cfg(target_os = "macos")]
    pub(super) fn watch_revocation(&self) -> Result<RevocationWatch, CandidateError> {
        watch_core(&self.core)
    }
    #[cfg(target_os = "macos")]
    pub(super) fn effect_guard(&self) -> EffectGuard {
        EffectGuard {
            core: Arc::clone(&self.core),
        }
    }

    /// The owning registry must retire the old authority before replacing a binding.
    pub fn new(credential: &Credential) -> Self {
        Self {
            core: Arc::new(Core {
                binding: credential.binding,
                key: Mutex::new(Some(Zeroizing::new(*credential.key))),
                signal: Mutex::new(None),
            }),
        }
    }
    /// Routing hint only: callers must still complete this authority's handshake.
    #[cfg(target_os = "macos")]
    pub(crate) fn matches_hello(&self, hello: &[u8]) -> bool {
        hello.len() == CLIENT_HELLO_BYTES
            && &hello[..8] == MAGIC
            && hello[8..104] == self.core.binding.bytes()
    }
    pub fn challenge(
        &self,
        hello: &[u8],
    ) -> Result<(ServerHandshake, [u8; SERVER_HELLO_BYTES]), CandidateError> {
        let deadline = Instant::now() + TTL;
        if hello.len() != CLIENT_HELLO_BYTES
            || &hello[..8] != MAGIC
            || hello[8..104] != self.core.binding.bytes()
        {
            return Err(refused());
        }
        let key = self.core.key.lock().map_err(|_| refused())?;
        fresh(deadline)?;
        let secret = key.as_ref().ok_or_else(refused)?;
        let mut client = [0; 32];
        client.copy_from_slice(&hello[104..]);
        let server = nonce()?;
        let mut response = [0; SERVER_HELLO_BYTES];
        response[..32].copy_from_slice(&server);
        response[32..].copy_from_slice(&tag(mac(
            &secret[..],
            b'S',
            self.core.binding,
            &client,
            &server,
        )?));
        Ok((
            ServerHandshake {
                core: Arc::clone(&self.core),
                client,
                server,
                deadline,
            },
            response,
        ))
    }
    /// Linearizes with effect callbacks. Once this returns no later callback can start.
    /// Bytes already handed to the kernel are not recalled; callers close active sockets.
    pub fn revoke(&self) {
        let mut key = self
            .core
            .key
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        key.take();
        // Lock order is always authority then signal. Closing the writer creates
        // persistent EOF, so no queued byte can be lost or consumed by another watcher.
        self.core
            .signal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }
}
pub struct ServerHandshake {
    core: Arc<Core>,
    client: [u8; 32],
    server: [u8; 32],
    deadline: Instant,
}
impl ServerHandshake {
    pub fn finish(self, proof: &[u8]) -> Result<(AuthorizedSession, [u8; 32]), CandidateError> {
        fresh(self.deadline)?;
        let key = self.core.key.lock().map_err(|_| refused())?;
        fresh(self.deadline)?;
        let secret = key.as_ref().ok_or_else(refused)?;
        mac(
            &secret[..],
            b'C',
            self.core.binding,
            &self.client,
            &self.server,
        )?
        .verify_slice(proof)
        .map_err(|_| refused())?;
        let accepted = tag(mac(
            &secret[..],
            b'A',
            self.core.binding,
            &self.client,
            &self.server,
        )?);
        Ok((
            AuthorizedSession {
                core: Arc::clone(&self.core),
                traffic: Some(traffic(
                    &secret[..],
                    self.core.binding,
                    &self.client,
                    &self.server,
                    false,
                )?),
            },
            accepted,
        ))
    }
}
pub struct AuthorizedSession {
    core: Arc<Core>,
    traffic: Option<Traffic>,
}
impl AuthorizedSession {
    /// A shared pollable revocation signal. Registration linearizes with revoke.
    /// Use outside effect callbacks; this acquires the same authority mutex.
    pub fn watch_revocation(&self) -> Result<RevocationWatch, CandidateError> {
        watch_core(&self.core)
    }

    /// One-shot extraction; keep this session to guard every actual effect. A
    /// codec can validate queued bytes after revocation but cannot authorize I/O.
    pub fn take_traffic(&mut self) -> Result<Traffic, CandidateError> {
        self.with_active(|| ())?;
        self.traffic.take().ok_or_else(refused)
    }
    #[cfg(target_os = "macos")]
    pub(super) fn effect_guard(&self) -> EffectGuard {
        EffectGuard {
            core: Arc::clone(&self.core),
        }
    }
    /// Use around each nonblocking effect, not around queue creation. The callback must
    /// be bounded and non-reentrant: it must not call revoke or another session callback.
    pub fn with_active<R>(&self, operation: impl FnOnce() -> R) -> Result<R, CandidateError> {
        with_active_core(&self.core, operation)
    }
}
/// Internal shareable admission token; cloning never copies key bytes or traffic state.
#[cfg(target_os = "macos")]
#[derive(Clone)]
pub(super) struct EffectGuard {
    core: Arc<Core>,
}
#[cfg(target_os = "macos")]
impl EffectGuard {
    pub(super) fn belongs_to(&self, authority: &Authority) -> bool {
        Arc::ptr_eq(&self.core, &authority.core)
    }
    pub(super) fn with_active<R>(
        &self,
        operation: impl FnOnce() -> R,
    ) -> Result<R, CandidateError> {
        with_active_core(&self.core, operation)
    }
}
fn with_active_core<R>(core: &Core, operation: impl FnOnce() -> R) -> Result<R, CandidateError> {
    let key = core.key.lock().map_err(|_| refused())?;
    if key.is_none() {
        return Err(refused());
    }
    let result = operation();
    drop(key);
    Ok(result)
}
#[cfg(test)]
#[path = "relay_auth/tests.rs"]
mod tests;

fn watch_core(core: &Core) -> Result<RevocationWatch, CandidateError> {
    let key = core.key.lock().map_err(|_| refused())?;
    if key.is_none() {
        return Err(refused());
    }
    let mut signal = core.signal.lock().map_err(|_| refused())?;
    if signal.is_none() {
        *signal = Some(revocation::Signal::new()?);
    }
    let watch = signal.as_ref().ok_or_else(refused)?.watch();
    drop(signal);
    drop(key);
    Ok(watch)
}
