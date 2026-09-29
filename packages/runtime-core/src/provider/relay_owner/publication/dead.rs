//! Owner-death witness, distinct from an authenticated live retirement acknowledgement.
//! The managed reactor owns its descriptors in threads of this process; std Unix
//! sockets are CLOEXEC and this implementation neither forks nor passes descriptors.
use super::*;
use std::os::fd::FromRawFd;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Selection {
    bytes: Vec<u8>,
    record_id: FileId,
}
impl Selection {
    fn pin(&self, root: &Path, context: Context) -> Result<PinnedEndpoint, CandidateError> {
        let paths = Paths::new(root)?;
        let receipt: Receipt = serde_json::from_slice(&self.bytes).map_err(|_| refused())?;
        if self.bytes.len() > LIMIT as usize
            || self.record_id.1 == 0
            || receipt.version != 1
            || receipt.runtime != context.runtime
            || receipt.boot != context.boot
            || context.runtime == [0; 16]
            || context.boot == [0; 16]
            || receipt.owner == [0; 16]
            || receipt.socket != paths.socket
            || receipt.parent != paths.parent()?
            || receipt.endpoint.1 == 0
            || !receipt.process.executable.is_absolute()
        {
            return Err(refused());
        }
        // SAFETY: geteuid takes no arguments.
        identity::verify(
            &receipt.process,
            &receipt.process,
            &receipt.process.executable,
            unsafe { libc::geteuid() },
        )?;
        Ok(PinnedEndpoint {
            paths,
            receipt,
            receipt_id: self.record_id,
            bytes: self.bytes.clone(),
        })
    }
}

pub(crate) struct Witness {
    pin: PinnedEndpoint,
    lock: state::Lock,
}
impl Witness {
    pub(crate) fn acquire(
        root: &Path,
        context: Context,
        process: &ProcessIdentity,
    ) -> Result<Self, CandidateError> {
        let paths = Paths::new(root)?;
        let lock = state::Lock::acquire_existing(&paths.directory)?;
        let pin = PinnedEndpoint::read(paths, context)?;
        if &pin.receipt.process != process {
            return Err(refused());
        }
        let witness = Self { pin, lock };
        witness.verify()?;
        Ok(witness)
    }
    pub(crate) fn selection(&self) -> Selection {
        Selection {
            bytes: self.pin.bytes.clone(),
            record_id: self.pin.receipt_id,
        }
    }
    pub(crate) fn verify(&self) -> Result<(), CandidateError> {
        let m = fs::symlink_metadata(self.pin.paths.directory.join("operation.lock"))
            .map_err(|_| refused())?;
        if id(&m) != self.lock.identity()? {
            return Err(refused());
        }
        self.pin.verify_dead()?;
        no_listener(&self.pin.paths.socket)
    }
}
/// Only an immediate connection refusal proves absence; a live or saturated
/// replacement listener must refuse recovery without blocking the provider lease.
pub(crate) fn no_listener(path: &Path) -> Result<(), CandidateError> {
    let bytes = path.as_os_str().as_encoded_bytes();
    // SAFETY: sockaddr_un is plain C storage, populated before connect.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.is_empty() || bytes.len() >= address.sun_path.len() || bytes.contains(&0) {
        return Err(refused());
    }
    address.sun_family = libc::AF_UNIX as _;
    for (to, from) in address.sun_path.iter_mut().zip(bytes) {
        *to = *from as _;
    }
    #[cfg(target_os = "macos")]
    {
        address.sun_len =
            (std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1) as u8;
    }
    // SAFETY: socket returns a fresh owned descriptor or -1.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(refused());
    }
    // SAFETY: successful socket transfers this descriptor exactly once.
    let stream = unsafe { UnixStream::from_raw_fd(fd) };
    // SAFETY: fd remains owned by stream throughout this call.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0
        || stream.set_nonblocking(true).is_err()
    {
        return Err(refused());
    }
    let length = std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1;
    // SAFETY: the initialized address remains live for the synchronous connect.
    let result = unsafe {
        libc::connect(
            fd,
            (&address as *const libc::sockaddr_un).cast(),
            length as libc::socklen_t,
        )
    };
    if result != -1 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ECONNREFUSED) {
        return Err(refused());
    }
    Ok(())
}

/// Caller must hold the provider lease and independently confirm graph cleanup.
/// The immutable selection makes either unlink interruption resumable. Missing
/// files are accepted only here, never as the initial owner-death witness.
pub(crate) fn retire(
    root: &Path,
    context: Context,
    selected: &Selection,
) -> Result<(), CandidateError> {
    let pin = selected.pin(root, context)?;
    let _lock = state::Lock::acquire_existing(&pin.paths.directory)?;
    if identity::alive(pin.receipt.process.pid)? {
        return Err(refused());
    }
    let record_absent = absent(&pin.paths.receipt)?;
    let socket_absent = absent(&pin.paths.socket)?;
    if record_absent && !socket_absent {
        return Err(refused());
    }
    if !record_absent {
        pin.verify_receipt()?;
    }
    if !socket_absent {
        pin.verify_socket()?;
        no_listener(&pin.paths.socket)?;
        fs::remove_file(&pin.paths.socket).map_err(|_| refused())?;
        pin.paths.sync()?;
    }
    if !record_absent {
        pin.verify_receipt()?;
        fs::remove_file(&pin.paths.receipt).map_err(|_| refused())?;
        pin.paths.sync()?;
    }
    Ok(())
}
