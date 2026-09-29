//! Persistent EOF notification: one lazy socket pair per authority, no wakeup writes.
use super::refused;
use crate::CandidateError;
use std::{
    io::Read,
    os::{
        fd::{AsFd, BorrowedFd},
        unix::net::UnixStream,
    },
    sync::Arc,
};

pub(super) struct Signal {
    read: Arc<UnixStream>,
    // Shutdown on drop is the notification. No writes means no overflow or SIGPIPE.
    _write: UnixStream,
}
impl Signal {
    pub(super) fn new() -> Result<Self, CandidateError> {
        let (read, write) = UnixStream::pair().map_err(|_| refused())?;
        read.set_nonblocking(true).map_err(|_| refused())?;
        write.set_nonblocking(true).map_err(|_| refused())?;
        Ok(Self {
            read: Arc::new(read),
            _write: write,
        })
    }
    #[cfg(test)]
    pub(super) fn duplicate_writer(&self) -> std::io::Result<UnixStream> {
        self._write.try_clone()
    }
    pub(super) fn watch(&self) -> RevocationWatch {
        RevocationWatch {
            read: Arc::clone(&self.read),
        }
    }
}

impl Drop for Signal {
    fn drop(&mut self) {
        // A fork/dup can retain another writer descriptor until exec or later.
        // Closing only our descriptor would delay EOF. Shutdown affects the shared
        // socket, so readiness does not depend on the lifetime of inherited copies.
        let _ = self._write.shutdown(std::net::Shutdown::Write);
    }
}

/// Register this descriptor for read/hangup readiness. All watches of an authority
/// share one receiver; EOF is persistent, so one observer cannot drain another's wakeup.
/// The reactor must drop its flow sockets when notified. This handle owns no authority
/// or key and does not itself close application sockets or spawn a background task.
#[derive(Clone)]
pub struct RevocationWatch {
    read: Arc<UnixStream>,
}
impl AsFd for RevocationWatch {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.read.as_fd()
    }
}
impl RevocationWatch {
    /// Nonblocking EOF observation. An error also requires the owning reactor to
    /// stop using the affected authority; it must not be treated as continued access.
    pub fn is_revoked(&self) -> Result<bool, CandidateError> {
        let mut read = &*self.read;
        match read.read(&mut [0]) {
            Ok(0) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(false),
            _ => Err(refused()),
        }
    }
}
