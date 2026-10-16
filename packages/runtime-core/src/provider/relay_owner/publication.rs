//! Private named control endpoint. File recovery does not prove relay retirement or
//! authorize a graph/VM mutation. Cooperative writers serialize in this directory.
use super::{
    Context, RelayOwner, RetireRequest, SelectionRequest, refused,
    transport::{ClientExchange, SelectionExchange},
};
use crate::{
    CandidateError,
    provider::{
        identity::{self, ProcessIdentity},
        state,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::{AsFd, BorrowedFd},
        unix::{
            fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
mod connect;
const LIMIT: u64 = 4096;
type FileId = (u64, u64);
fn id(m: &fs::Metadata) -> FileId {
    (m.dev(), m.ino())
}
fn private(m: &fs::Metadata) -> bool {
    // SAFETY: geteuid has no pointer arguments.
    m.uid() == unsafe { libc::geteuid() } && m.mode() & 0o077 == 0
}
#[derive(Clone)]
struct Paths {
    directory: PathBuf,
    socket: PathBuf,
    receipt: PathBuf,
}
impl Paths {
    fn new(root: &Path) -> Result<Self, CandidateError> {
        if !root.is_absolute() {
            return Err(refused());
        }
        state::check_private_directory(root).map_err(|_| refused())?;
        let directory = root.join("relay-control");
        let socket = directory.join("control.sock");
        if socket.as_os_str().len() > 100 {
            return Err(refused());
        }
        Ok(Self {
            receipt: directory.join("owner.json"),
            directory,
            socket,
        })
    }
    fn parent(&self) -> Result<FileId, CandidateError> {
        state::check_private_directory(&self.directory).map_err(|_| refused())?;
        let m = fs::symlink_metadata(&self.directory).map_err(|_| refused())?;
        if !m.is_dir() {
            return Err(refused());
        }
        Ok(id(&m))
    }
    fn sync(&self) -> Result<(), CandidateError> {
        File::open(&self.directory)
            .and_then(|f| f.sync_all())
            .map_err(|_| refused())
    }
}
fn absent(path: &Path) -> Result<bool, CandidateError> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Ok(_) => Ok(false),
        Err(_) => Err(refused()),
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u8,
    runtime: [u8; 16],
    boot: [u8; 16],
    owner: [u8; 16],
    process: ProcessIdentity,
    socket: PathBuf,
    parent: FileId,
    endpoint: FileId,
}

/// Immutable selected receipt, not a live-process or lifecycle-completion claim.
#[derive(Clone)]
pub struct PinnedEndpoint {
    paths: Paths,
    receipt: Receipt,
    receipt_id: FileId,
    bytes: Vec<u8>,
}
impl PinnedEndpoint {
    pub(crate) fn runtime_root(&self) -> &Path {
        self.paths
            .directory
            .parent()
            .expect("fixed child publication directory")
    }
    pub(super) fn context(&self) -> Context {
        Context {
            runtime: self.receipt.runtime,
            boot: self.receipt.boot,
        }
    }
    pub(super) fn process(&self) -> &ProcessIdentity {
        &self.receipt.process
    }
    pub(super) fn verify_current(&self) -> Result<(), CandidateError> {
        self.verify_receipt()?;
        self.verify_socket()?;
        identity::verify(
            &self.receipt.process,
            &identity::observe(self.receipt.process.pid)?,
            &self.receipt.process.executable,
            self.receipt.process.uid,
        )
        .map_err(|_| refused())
    }
    pub fn load(root: &Path, context: Context) -> Result<Self, CandidateError> {
        Self::read(Paths::new(root)?, context)
    }
    fn read(paths: Paths, context: Context) -> Result<Self, CandidateError> {
        let parent = paths.parent()?;
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&paths.receipt)
            .map_err(|_| refused())?;
        let m = file.metadata().map_err(|_| refused())?;
        if !m.is_file() || !private(&m) || m.nlink() != 1 || m.len() > LIMIT {
            return Err(refused());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| refused())?;
        if bytes.len() as u64 > LIMIT {
            return Err(refused());
        }
        let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        if receipt.version != 1
            || receipt.runtime != context.runtime
            || receipt.boot != context.boot
            || context.runtime == [0; 16]
            || context.boot == [0; 16]
            || receipt.owner == [0; 16]
            || receipt.socket != paths.socket
            || receipt.parent != parent
            || receipt.endpoint.1 == 0
            || !receipt.process.executable.is_absolute()
        {
            return Err(refused());
        }
        // SAFETY: geteuid has no pointer arguments. This validates receipt shape only.
        identity::verify(
            &receipt.process,
            &receipt.process,
            &receipt.process.executable,
            unsafe { libc::geteuid() },
        )
        .map_err(|_| refused())?;
        Ok(Self {
            paths,
            receipt,
            receipt_id: id(&m),
            bytes,
        })
    }
    pub fn incarnation(&self) -> [u8; 16] {
        self.receipt.owner
    }
    pub fn fingerprint(&self) -> [u8; 32] {
        Sha256::digest(&self.bytes).into()
    }
    fn verify_receipt(&self) -> Result<(), CandidateError> {
        let current = Self::read(
            self.paths.clone(),
            Context {
                runtime: self.receipt.runtime,
                boot: self.receipt.boot,
            },
        )?;
        if current.receipt_id != self.receipt_id || current.bytes != self.bytes {
            return Err(refused());
        }
        Ok(())
    }
    fn verify_socket(&self) -> Result<(), CandidateError> {
        if self.paths.parent()? != self.receipt.parent {
            return Err(refused());
        }
        let m = fs::symlink_metadata(&self.paths.socket).map_err(|_| refused())?;
        if !m.file_type().is_socket()
            || !private(&m)
            || m.nlink() != 1
            || id(&m) != self.receipt.endpoint
        {
            return Err(refused());
        }
        Ok(())
    }
    /// Connect without blocking on a full backlog, and release no request bytes before
    /// native peer verification. An unavailable/pending connection refuses for retry.
    pub fn connect(
        &self,
        request: RetireRequest,
        budget: Duration,
    ) -> Result<ClientExchange, CandidateError> {
        if request.owner != self.receipt.owner {
            return Err(refused());
        }
        let (stream, remaining) = self.connect_stream(budget)?;
        ClientExchange::new(stream, &self.receipt.process, request, remaining)
    }
    pub fn select(
        &self,
        request: SelectionRequest,
        budget: Duration,
    ) -> Result<SelectionExchange, CandidateError> {
        if request.owner != self.receipt.owner {
            return Err(refused());
        }
        let (stream, remaining) = self.connect_stream(budget)?;
        SelectionExchange::new(stream, &self.receipt.process, request, remaining)
    }
    fn connect_stream(&self, budget: Duration) -> Result<(UnixStream, Duration), CandidateError> {
        if budget.is_zero() || budget > Duration::from_secs(5) {
            return Err(refused());
        }
        let deadline = Instant::now() + budget;
        self.verify_receipt()?;
        self.verify_socket()?;
        identity::verify(
            &self.receipt.process,
            &identity::observe(self.receipt.process.pid)?,
            &self.receipt.process.executable,
            self.receipt.process.uid,
        )
        .map_err(|_| refused())?;
        let stream = connect::immediate(&self.paths.socket)?;
        self.verify_receipt()?;
        self.verify_socket()?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(refused)?;
        Ok((stream, remaining))
    }
    /// Explicit recovery of this exact selected receipt. A reused/live PID, held lock,
    /// changed parent, receipt or socket refuses. No process is ever signalled.
    /// Removing these files is not permission to replay or begin a lifecycle effect.
    pub fn recover(&self) -> Result<(), CandidateError> {
        if self.paths.parent()? != self.receipt.parent {
            return Err(refused());
        }
        let _lock = state::Lock::acquire(&self.paths.directory).map_err(|_| refused())?;
        if absent(&self.paths.receipt)? && absent(&self.paths.socket)? {
            return Ok(());
        }
        self.verify_receipt()?;
        if identity::alive(self.receipt.process.pid)? {
            return Err(refused());
        }
        self.remove_files()
    }
    fn remove_files(&self) -> Result<(), CandidateError> {
        self.verify_receipt()?;
        if !absent(&self.paths.socket)? {
            self.verify_socket()?;
            fs::remove_file(&self.paths.socket).map_err(|_| refused())?;
        }
        fs::remove_file(&self.paths.receipt).map_err(|_| refused())?;
        self.paths.sync()
    }
}

/// The lock covers this dedicated publication directory, not the runtime mutation
/// lease. Caller owns lifecycle shutdown order; dropping this only closes discovery.
pub struct ControlListener {
    listener: UnixListener,
    endpoint: PinnedEndpoint,
    _lock: state::Lock,
}
impl ControlListener {
    pub fn bind(root: &Path, owner: &mut RelayOwner) -> Result<Self, CandidateError> {
        let paths = Paths::new(root)?;
        owner.bind_control_root(root)?;
        state::private_directory(&paths.directory).map_err(|_| refused())?;
        let lock = state::Lock::acquire(&paths.directory).map_err(|_| refused())?;
        let parent = paths.parent()?;
        if !absent(&paths.socket)? || !absent(&paths.receipt)? {
            return Err(refused());
        }
        let listener = UnixListener::bind(&paths.socket).map_err(|_| refused())?;
        // Any partial publication is preserved on failure for explicit diagnosis; a
        // later bind never adopts/unlinks a path simply because this name is expected.
        fs::set_permissions(&paths.socket, fs::Permissions::from_mode(0o600))
            .map_err(|_| refused())?;
        listener.set_nonblocking(true).map_err(|_| refused())?;
        let m = fs::symlink_metadata(&paths.socket).map_err(|_| refused())?;
        let receipt = Receipt {
            version: 1,
            runtime: owner.context.runtime,
            boot: owner.context.boot,
            owner: owner.incarnation(),
            process: identity::observe(std::process::id() as i32)?,
            socket: paths.socket.clone(),
            parent,
            endpoint: id(&m),
        };
        let bytes = serde_json::to_vec(&receipt).map_err(|_| refused())?;
        if bytes.len() as u64 > LIMIT {
            return Err(refused());
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&paths.receipt)
            .map_err(|_| refused())?;
        let receipt_id = id(&file.metadata().map_err(|_| refused())?);
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| refused())?;
        paths.sync()?;
        let endpoint = PinnedEndpoint {
            paths,
            receipt,
            receipt_id,
            bytes,
        };
        endpoint.verify_receipt()?;
        endpoint.verify_socket()?;
        Ok(Self {
            listener,
            endpoint,
            _lock: lock,
        })
    }
    pub fn endpoint(&self) -> PinnedEndpoint {
        self.endpoint.clone()
    }
    /// Accept at most one client, deriving same-user identity from the native socket.
    /// Private directory ownership is the authority boundary, not a claimed JSON PID.
    /// Omit this listener from polling when the owner's control capacity is full.
    pub fn accept(&self, owner: &mut RelayOwner, budget: Duration) -> Result<bool, CandidateError> {
        if owner.incarnation() != self.endpoint.incarnation()
            || owner.controls.len() >= owner.control_capacity
        {
            return Err(refused());
        }
        self.verify_owner()?;
        self.endpoint.verify_receipt()?;
        self.endpoint.verify_socket()?;
        let (stream, _) = match self.listener.accept() {
            Ok(pair) => pair,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
            Err(_) => return Err(refused()),
        };
        self.endpoint.verify_receipt()?;
        self.endpoint.verify_socket()?;
        let coordinator = super::transport::observe_peer(&stream)?;
        owner.admit_control(stream, &coordinator, budget)?;
        Ok(true)
    }
    fn verify_owner(&self) -> Result<(), CandidateError> {
        let expected = &self.endpoint.receipt.process;
        identity::verify(
            expected,
            &identity::observe(std::process::id() as i32)?,
            &expected.executable,
            expected.uid,
        )
        .map_err(|_| refused())
    }
}
impl AsFd for ControlListener {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.listener.as_fd()
    }
}
impl Drop for ControlListener {
    fn drop(&mut self) {
        if self.verify_owner().is_ok() {
            let _ = self.endpoint.remove_files();
        }
    }
}

#[cfg(test)]
mod tests;
