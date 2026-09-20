//! Versioned, bounded stream framing; callers authenticate and admit flows separately.
//! FIN ends one application direction without calling shutdown on the underlying transport.
use crate::CandidateError;

pub const MAX_DATA: usize = 16 * 1024;
const HEADER: usize = 8;
const MAGIC: &[u8; 4] = b"HKF1";

#[derive(Debug, PartialEq, Eq)]
pub enum Frame<'a> {
    Data(&'a [u8]),
    Fin,
    Reset,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Open,
    Finished,
    Reset,
    Poisoned,
}

fn invalid() -> CandidateError {
    CandidateError::new(
        "relay_frame",
        "Malformed, oversized or out-of-order relay frame.",
    )
}

fn transition(phase: Phase, kind: u8, length: usize) -> Result<Phase, CandidateError> {
    match (phase, kind, length) {
        (Phase::Open, 1, 1..=MAX_DATA) => Ok(Phase::Open),
        (Phase::Open, 2, 0) => Ok(Phase::Finished),
        (Phase::Open | Phase::Finished, 3, 0) => Ok(Phase::Reset),
        _ => Err(invalid()),
    }
}

/// Sender state is advanced when a frame is encoded. The caller must queue it in order,
/// bound outstanding output and fail the flow if any encoded frame cannot be delivered.
#[derive(Default)]
pub struct Encoder {
    phase: Phase,
}
impl Encoder {
    pub fn encode(&mut self, frame: Frame<'_>) -> Result<Vec<u8>, CandidateError> {
        let (kind, payload) = match frame {
            Frame::Data(data) => (1, data),
            Frame::Fin => (2, &[][..]),
            Frame::Reset => (3, &[][..]),
        };
        let next = transition(self.phase, kind, payload.len())?;
        let length = payload.len();
        let mut bytes = Vec::with_capacity(HEADER + length);
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&[
            kind,
            (length >> 16) as u8,
            (length >> 8) as u8,
            length as u8,
        ]);
        bytes.extend_from_slice(payload);
        self.phase = next;
        Ok(bytes)
    }
}

/// One fixed-size buffer, independent of untrusted advertised length. A returned DATA
/// slice borrows this decoder, so it must be consumed before the next frame is decoded.
pub struct Decoder {
    buffer: [u8; HEADER + MAX_DATA],
    used: usize,
    needed: usize,
    phase: Phase,
}
impl Default for Decoder {
    fn default() -> Self {
        Self {
            buffer: [0; HEADER + MAX_DATA],
            used: 0,
            needed: HEADER,
            phase: Phase::Open,
        }
    }
}
impl Decoder {
    /// Consume no more than one frame, returning exactly the number of input bytes used.
    /// Errors are terminal; callers must close the flow rather than resume parsing.
    pub fn push<'a>(
        &'a mut self,
        input: &[u8],
    ) -> Result<(usize, Option<Frame<'a>>), CandidateError> {
        if self.phase == Phase::Poisoned || self.phase == Phase::Reset {
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
            let kind = self.buffer[4];
            let length = ((self.buffer[5] as usize) << 16)
                | ((self.buffer[6] as usize) << 8)
                | self.buffer[7] as usize;
            if &self.buffer[..4] != MAGIC || transition(self.phase, kind, length).is_err() {
                self.phase = Phase::Poisoned;
                return Err(invalid());
            }
            self.needed = HEADER + length;
            if self.used < self.needed {
                continue;
            }
            self.phase = transition(self.phase, kind, length)?;
            self.used = 0;
            self.needed = HEADER;
            return Ok((
                consumed,
                Some(match kind {
                    1 => Frame::Data(&self.buffer[HEADER..HEADER + length]),
                    2 => Frame::Fin,
                    _ => Frame::Reset,
                }),
            ));
        }
        Ok((consumed, None))
    }

    /// Transport EOF is graceful only after a complete explicit FIN, never on a
    /// partial header/payload, an unannounced close or a peer RESET.
    pub fn finish_transport(&mut self) -> Result<(), CandidateError> {
        if self.used == 0 && self.phase == Phase::Finished {
            Ok(())
        } else {
            self.phase = Phase::Poisoned;
            Err(CandidateError::new(
                "relay_frame_truncated",
                "Relay transport ended without a complete graceful FIN.",
            ))
        }
    }
}

#[cfg(test)]
#[path = "relay_frame/tests.rs"]
mod tests;
