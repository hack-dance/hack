//! Authenticated, ordered records around HKF1. Integrity only, not encryption.
//! Traffic codecs do not authorize effects: use the session's revocation guard at I/O.
use super::relay_frame::{self, Frame};
use crate::CandidateError;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::Zeroizing;

const HEADER: usize = 8;
const PREFIX: usize = HEADER + 8;
const TAG: usize = 32;
const MIN_INNER: usize = 8;
pub const MAX_WIRE: usize = PREFIX + MIN_INNER + relay_frame::MAX_DATA + TAG;
const DOMAIN: &[u8] = b"Hack relay record v1\0";
const MAGIC: &[u8; 4] = b"HKI1";
type HmacSha256 = Hmac<Sha256>;

fn invalid() -> CandidateError {
    CandidateError::new(
        "relay_integrity",
        "Relay record integrity or ordering failed.",
    )
}
fn mac(key: &[u8], record: &[u8]) -> Result<HmacSha256, CandidateError> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| invalid())?;
    mac.update(DOMAIN);
    mac.update(record);
    Ok(mac)
}

/// Created only by an accepted handshake; direction-specific keys are not exposed.
/// The server must retain its AuthorizedSession and gate actual effects with it.
pub struct Traffic {
    pub send: Sender,
    pub receive: Receiver,
}
impl Traffic {
    pub(super) fn new(send: Zeroizing<[u8; 32]>, receive: Zeroizing<[u8; 32]>) -> Self {
        Self {
            send: Sender {
                key: send,
                sequence: Some(0),
                inner: relay_frame::Encoder::default(),
            },
            receive: Receiver {
                key: receive,
                sequence: Some(0),
                inner: relay_frame::Decoder::default(),
                buffer: [0; MAX_WIRE],
                used: 0,
                needed: HEADER,
                poisoned: false,
            },
        }
    }
}

/// Queue each result in order with bounded outstanding bytes. Encoding advances the
/// sequence; a failed/abandoned write terminates the flow rather than resetting it.
pub struct Sender {
    key: Zeroizing<[u8; 32]>,
    sequence: Option<u64>,
    inner: relay_frame::Encoder,
}
impl Sender {
    pub fn encode(&mut self, frame: Frame<'_>) -> Result<Vec<u8>, CandidateError> {
        let sequence = self.sequence.ok_or_else(invalid)?;
        let inner = self.inner.encode(frame)?;
        let mut record = Vec::with_capacity(PREFIX + inner.len() + TAG);
        record.extend_from_slice(MAGIC);
        record.extend_from_slice(&(inner.len() as u32).to_be_bytes());
        record.extend_from_slice(&sequence.to_be_bytes());
        record.extend_from_slice(&inner);
        let tag = mac(&self.key[..], &record)?.finalize().into_bytes();
        record.extend_from_slice(&tag);
        self.sequence = sequence.checked_add(1);
        Ok(record)
    }
}

/// Two fixed bounded buffers (outer authenticated record and inner HKF1 decoder).
/// Nothing from the inner record is exposed until its MAC and sequence validate.
/// Any error poisons parsing; the caller must close the flow.
pub struct Receiver {
    key: Zeroizing<[u8; 32]>,
    sequence: Option<u64>,
    inner: relay_frame::Decoder,
    buffer: [u8; MAX_WIRE],
    used: usize,
    needed: usize,
    poisoned: bool,
}
impl Receiver {
    /// Maximum bytes accepted before the next parsing boundary. A transport can
    /// use this to avoid reading past a record without retaining an extra input queue.
    pub fn read_capacity(&self) -> usize {
        if self.poisoned || self.sequence.is_none() {
            0
        } else {
            self.needed - self.used
        }
    }
    /// Consume at most one record. DATA borrows this receiver until consumed.
    pub fn push<'a>(
        &'a mut self,
        input: &[u8],
    ) -> Result<(usize, Option<Frame<'a>>), CandidateError> {
        if self.poisoned || self.sequence.is_none() {
            self.poisoned = true;
            return Err(invalid());
        }
        let mut consumed = 0;
        while consumed < input.len() {
            let take = (self.needed - self.used).min(input.len() - consumed);
            self.buffer[self.used..self.used + take]
                .copy_from_slice(&input[consumed..consumed + take]);
            self.used += take;
            consumed += take;
            if self.used < self.needed {
                break;
            }
            // Assume failure until the entire authenticated inner record is accepted.
            self.poisoned = true;
            let length =
                u32::from_be_bytes(self.buffer[4..8].try_into().map_err(|_| invalid())?) as usize;
            if &self.buffer[..4] != MAGIC
                || !(MIN_INNER..=MIN_INNER + relay_frame::MAX_DATA).contains(&length)
            {
                return Err(invalid());
            }
            self.needed = PREFIX + length + TAG;
            if self.used < self.needed {
                self.poisoned = false;
                continue;
            }
            let tag_at = self.needed - TAG;
            mac(&self.key[..], &self.buffer[..tag_at])?
                .verify_slice(&self.buffer[tag_at..self.needed])
                .map_err(|_| invalid())?;
            let sequence =
                u64::from_be_bytes(self.buffer[8..PREFIX].try_into().map_err(|_| invalid())?);
            if Some(sequence) != self.sequence {
                return Err(invalid());
            }
            let (used, frame) = self
                .inner
                .push(&self.buffer[PREFIX..tag_at])
                .map_err(|_| invalid())?;
            if used != length || frame.is_none() {
                return Err(invalid());
            }
            self.sequence = sequence.checked_add(1);
            self.used = 0;
            self.needed = HEADER;
            self.poisoned = false;
            return Ok((consumed, frame));
        }
        Ok((consumed, None))
    }
    /// Requires a complete authenticated FIN and no partial outer record.
    pub fn finish_transport(&mut self) -> Result<(), CandidateError> {
        if self.poisoned || self.used != 0 || self.inner.finish_transport().is_err() {
            self.poisoned = true;
            return Err(invalid());
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "relay_integrity/tests.rs"]
mod tests;
