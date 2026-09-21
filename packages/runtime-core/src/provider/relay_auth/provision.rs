//! One-use private descriptor delivery. No credential files, arguments or logging.
use super::{Binding, Credential, refused};
use crate::CandidateError;
#[cfg(test)]
use std::{fs::File, io::Read, time::Instant};
use std::{
    io::Write,
    os::{fd::OwnedFd, unix::net::UnixStream},
    process::Stdio,
    time::Duration,
};
use zeroize::Zeroizing;

const MAGIC: &[u8; 8] = b"HKRP0001";
const LENGTH: usize = 8 + 96 + 32;

/// A consumed credential ready for an explicitly owned child's stdin. Deliberately
/// not Debug, Clone, Read or Serialize. The caller owns child identity, stdin-only
/// forwarding and failure revocation; creating this value proves none of those.
pub struct PrivateInput(UnixStream);
impl PrivateInput {
    /// Forward exactly one consumed credential to an already authenticated local
    /// exec stdin. No caller-visible bytes or durable representation is produced.
    pub(crate) fn forward(
        self,
        stream: &mut UnixStream,
        deadline: std::time::Instant,
    ) -> Result<(), CandidateError> {
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(refused)?;
        // Poll-based receive also handles macOS rejecting SO_RCVTIMEO on the
        // already closed writer half of this one-use anonymous channel.
        let bytes = super::super::private_input::receive(
            self.0.into(),
            remaining.min(Duration::from_secs(5)),
            LENGTH,
        )?;
        if bytes.len() != LENGTH || &bytes[..8] != MAGIC {
            return Err(refused());
        }
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(refused)?;
        stream
            .set_write_timeout(Some(remaining))
            .map_err(|_| refused())?;
        stream.write_all(&bytes[..]).map_err(|_| refused())?;
        stream
            .shutdown(std::net::Shutdown::Write)
            .map_err(|_| refused())
    }

    pub fn into_stdin(self) -> Stdio {
        Stdio::from(OwnedFd::from(self.0))
    }
}

impl Credential {
    /// Move this credential into a bounded anonymous channel. The writer closes
    /// before return, so the receiving child can require exact length and EOF.
    /// The caller must revoke the associated registration if launch/delivery fails.
    pub fn into_private_input(self) -> Result<PrivateInput, CandidateError> {
        let (reader, mut writer) = UnixStream::pair().map_err(|_| refused())?;
        writer.set_nonblocking(true).map_err(|_| refused())?;
        let mut bytes = Zeroizing::new([0_u8; LENGTH]);
        bytes[..8].copy_from_slice(MAGIC);
        bytes[8..104].copy_from_slice(&self.binding.bytes());
        bytes[104..].copy_from_slice(&self.key[..]);
        writer.write_all(&bytes[..]).map_err(|_| refused())?;
        drop(writer);
        Ok(PrivateInput(reader))
    }

    /// Receive one credential from an inherited pipe or local socket. Regular
    /// files, terminals and network sockets refuse. The descriptor is consumed;
    /// framing, deadline and EOF are checked before releasing the credential.
    /// This validates delivery syntax, not the sender's authority or graph identity.
    pub fn from_private_descriptor(fd: OwnedFd, budget: Duration) -> Result<Self, CandidateError> {
        let bytes =
            super::super::private_input::receive(fd, budget, LENGTH).map_err(|_| refused())?;
        if bytes.len() != LENGTH || &bytes[..8] != MAGIC {
            return Err(refused());
        }
        let binding = Binding {
            owner: bytes[8..24].try_into().map_err(|_| refused())?,
            boot: bytes[24..40].try_into().map_err(|_| refused())?,
            endpoint: bytes[40..72].try_into().map_err(|_| refused())?,
            service: bytes[72..104].try_into().map_err(|_| refused())?,
        };
        Self::from_private_input(
            binding,
            bytes[104..LENGTH].try_into().map_err(|_| refused())?,
        )
    }
}

#[cfg(test)]
#[path = "provision/tests.rs"]
mod tests;
