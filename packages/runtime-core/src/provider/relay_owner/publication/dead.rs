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
            device_rebind: None,
        })
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn identity(
        &self,
        root: &Path,
        context: Context,
    ) -> Result<(ProcessIdentity, [u8; 16], [u8; 32]), CandidateError> {
        let pin = self.pin(root, context)?;
        Ok((
            pin.receipt.process.clone(),
            pin.incarnation(),
            pin.fingerprint(),
        ))
    }
}

pub(crate) struct Witness {
    pin: PinnedEndpoint,
    lock: state::Lock,
}
/// A clean managed owner exit unlinks both publication paths while leaving the
/// operation lock. Absence is only a current endpoint fact: callers must bind
/// the original owner/process/publication to a selected coordinator record, or
/// bind the exact dead foreground process to a ready graph receipt and its
/// current-boot run-derived control root. Absence alone grants no cleanup.
pub(crate) enum CleanupWitness {
    Present(Witness),
    Absent(AbsentWitness),
}

pub(crate) struct AbsentWitness {
    paths: Paths,
    lock: state::Lock,
    parent: FileId,
    process: ProcessIdentity,
}

#[derive(Serialize)]
struct AbsentSelection<'a> {
    kind: &'static str,
    parent: FileId,
    lock: FileId,
    process: &'a ProcessIdentity,
}

impl CleanupWitness {
    pub(crate) fn acquire(
        root: &Path,
        context: Context,
        process: &ProcessIdentity,
    ) -> Result<Self, CandidateError> {
        let paths = Paths::new(root)?;
        let lock = state::Lock::acquire_existing(&paths.directory)?;
        match (absent(&paths.receipt)?, absent(&paths.socket)?) {
            (false, false) => {
                let pin = PinnedEndpoint::read(paths, context)?;
                if &pin.receipt.process != process {
                    return Err(refused());
                }
                let witness = Witness { pin, lock };
                witness.verify()?;
                Ok(Self::Present(witness))
            }
            (true, true) if context.runtime != [0; 16] && context.boot != [0; 16] => {
                // SAFETY: geteuid takes no arguments.
                identity::verify(process, process, &process.executable, unsafe {
                    libc::geteuid()
                })?;
                let parent = paths.parent()?;
                let witness = AbsentWitness {
                    paths,
                    lock,
                    parent,
                    process: process.clone(),
                };
                witness.verify()?;
                Ok(Self::Absent(witness))
            }
            _ => Err(refused()),
        }
    }

    pub(crate) fn selection_sha256(&self) -> Result<String, CandidateError> {
        let bytes = match self {
            Self::Present(witness) => {
                serde_json::to_vec(&witness.selection()).map_err(|_| refused())?
            }
            Self::Absent(witness) => serde_json::to_vec(&AbsentSelection {
                kind: "absent",
                parent: witness.parent,
                lock: witness.lock.identity()?,
                process: &witness.process,
            })
            .map_err(|_| refused())?,
        };
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }

    pub(crate) fn present_identity(&self) -> Option<([u8; 16], [u8; 32])> {
        match self {
            Self::Present(witness) => Some((witness.owner(), witness.publication())),
            Self::Absent(_) => None,
        }
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn present_selection(&self) -> Option<Selection> {
        match self {
            Self::Present(witness) => Some(witness.selection()),
            Self::Absent(_) => None,
        }
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn lock_identity(&self) -> Result<FileId, CandidateError> {
        match self {
            Self::Present(witness) => witness.lock_identity(),
            Self::Absent(witness) => witness.lock.identity(),
        }
    }

    pub(crate) fn verify(&self) -> Result<(), CandidateError> {
        match self {
            Self::Present(witness) => witness.verify(),
            Self::Absent(witness) => witness.verify(),
        }
    }
}

impl AbsentWitness {
    fn verify(&self) -> Result<(), CandidateError> {
        let lock = fs::symlink_metadata(self.paths.directory.join("operation.lock"))
            .map_err(|_| refused())?;
        if self.paths.parent()? != self.parent
            || !lock.is_file()
            || lock.nlink() != 1
            || !private(&lock)
            || id(&lock) != self.lock.identity()?
            || !absent(&self.paths.receipt)?
            || !absent(&self.paths.socket)?
            || identity::alive(self.process.pid)?
        {
            return Err(refused());
        }
        Ok(())
    }
}
impl Witness {
    #[cfg(test)]
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
    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn lock_identity(&self) -> Result<FileId, CandidateError> {
        self.lock.identity()
    }
    pub(crate) fn owner(&self) -> [u8; 16] {
        self.pin.incarnation()
    }
    pub(crate) fn publication(&self) -> [u8; 32] {
        self.pin.fingerprint()
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
    retire_checked(root, context, selected, None, &|| Ok(()))
}

/// The selected acknowledged-cleanup caller also pins the control lock inode
/// and rechecks its graph proof immediately before each unlink.
pub(crate) fn retire_checked(
    root: &Path,
    context: Context,
    selected: &Selection,
    expected_lock: Option<FileId>,
    verify: &dyn Fn() -> Result<(), CandidateError>,
) -> Result<(), CandidateError> {
    let pin = selected.pin(root, context)?;
    let _lock = state::Lock::acquire_existing(&pin.paths.directory)?;
    let exact_lock = || -> Result<(), CandidateError> {
        if let Some(expected) = expected_lock {
            let named = fs::symlink_metadata(pin.paths.directory.join("operation.lock"))
                .map_err(|_| refused())?;
            if !named.is_file()
                || named.nlink() != 1
                || !private(&named)
                || id(&named) != expected
                || _lock.identity()? != expected
            {
                return Err(refused());
            }
        }
        verify()
    };
    exact_lock()?;
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
        exact_lock()?;
        pin.verify_socket()?;
        no_listener(&pin.paths.socket)?;
        fs::remove_file(&pin.paths.socket).map_err(|_| refused())?;
        pin.paths.sync()?;
    }
    if !record_absent {
        exact_lock()?;
        pin.verify_receipt()?;
        fs::remove_file(&pin.paths.receipt).map_err(|_| refused())?;
        pin.paths.sync()?;
    }
    exact_lock()?;
    Ok(())
}
