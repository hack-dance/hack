use super::{Candidate, CandidateError, refused};
use crate::provider::{
    identity::{self, ProcessIdentity},
    state,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::Shutdown,
    os::{
        fd::{AsRawFd, RawFd},
        unix::{
            fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::PathBuf,
    time::{Duration, Instant},
};
use zeroize::{Zeroize, Zeroizing};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WireRequest {
    pub version: u8,
    pub run: String,
    pub remove_data: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore: Option<RestoreRequest>,
}
pub(super) const REQUEST_LIMIT: usize = 132 * 1024;
const PRIVATE_LIMIT: usize = 64 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RestoreRequest {
    pub plan: String,
    pub generation: String,
    pub environment: PrivateText,
}

pub(super) struct PrivateText(String);
impl PrivateText {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CandidateError> {
        if bytes.is_empty() || bytes.len() > PRIVATE_LIMIT {
            return Err(refused());
        }
        let text = std::str::from_utf8(bytes).map_err(|_| refused())?;
        Ok(Self(text.to_owned()))
    }
    pub fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }
}
impl Drop for PrivateText {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
impl Serialize for PrivateText {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}
impl<'de> Deserialize<'de> for PrivateText {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl serde::de::Visitor<'_> for Visitor {
            type Value = PrivateText;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("bounded private text")
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                PrivateText::from_bytes(value.as_bytes())
                    .map_err(|_| E::custom("private text refused"))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                mut value: String,
            ) -> Result<Self::Value, E> {
                if value.is_empty() || value.len() > PRIVATE_LIMIT {
                    value.zeroize();
                    return Err(E::custom("private text refused"));
                }
                Ok(PrivateText(value))
            }
        }
        deserializer.deserialize_string(Visitor)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    candidate: PathBuf,
    run: String,
    process: ProcessIdentity,
    parent: (u64, u64),
    socket: (u64, u64),
}
fn root(candidate: &Candidate, run: &str) -> Result<PathBuf, CandidateError> {
    if !super::super::hex(run, 32) {
        return Err(refused());
    }
    let bytes = serde_json::to_vec(&("hack-graph-foreground-v1", &candidate.state_root, run))
        .map_err(|_| refused())?;
    Ok(PathBuf::from(format!(
        "/private/tmp/hkgf-{}",
        &format!("{:x}", Sha256::digest(bytes))[..24]
    )))
}
fn id(m: &fs::Metadata) -> (u64, u64) {
    (m.dev(), m.ino())
}
fn private(m: &fs::Metadata) -> bool {
    // SAFETY: geteuid has no arguments or effects.
    m.uid() == unsafe { libc::geteuid() } && m.mode() & 0o077 == 0
}
fn peer(stream: &UnixStream) -> Result<ProcessIdentity, CandidateError> {
    let (mut uid, mut gid, mut pid) = (0, 0, 0i32);
    let mut len = std::mem::size_of_val(&pid) as libc::socklen_t;
    // SAFETY: all output pointers reference correctly sized initialized storage;
    // the stream retains its descriptor throughout these synchronous calls.
    let valid = unsafe {
        libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) == 0
            && uid == libc::geteuid()
            && libc::getsockopt(
                stream.as_raw_fd(),
                0,
                libc::LOCAL_PEERPID,
                (&mut pid as *mut i32).cast(),
                &mut len,
            ) == 0
    };
    if !valid || len as usize != std::mem::size_of_val(&pid) {
        return Err(refused());
    }
    let observed = identity::observe(pid).map_err(|_| refused())?;
    identity::verify(&observed, &observed, &observed.executable, uid).map_err(|_| refused())?;
    Ok(observed)
}
pub(super) struct Pin {
    root: PathBuf,
    record: Record,
    bytes: Vec<u8>,
    record_id: (u64, u64),
}
impl Pin {
    pub fn load(candidate: &Candidate, run: &str) -> Result<Self, CandidateError> {
        let root = root(candidate, run)?;
        state::check_private_directory(&root).map_err(|_| refused())?;
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(root.join("owner.json"))
            .map_err(|_| refused())?;
        let metadata = file.metadata().map_err(|_| refused())?;
        if !metadata.is_file()
            || !private(&metadata)
            || metadata.nlink() != 1
            || metadata.len() > 8192
        {
            return Err(refused());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(8193)
            .read_to_end(&mut bytes)
            .map_err(|_| refused())?;
        if bytes.len() > 8192 {
            return Err(refused());
        }
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        if record.version != 1 || record.candidate != candidate.checkout || record.run != run {
            return Err(refused());
        }
        let pin = Self {
            root,
            record,
            bytes,
            record_id: id(&metadata),
        };
        pin.verify()?;
        Ok(pin)
    }
    fn verify_files(&self) -> Result<(), CandidateError> {
        state::check_private_directory(&self.root).map_err(|_| refused())?;
        let parent = fs::symlink_metadata(&self.root).map_err(|_| refused())?;
        let socket = fs::symlink_metadata(self.root.join("control.sock")).map_err(|_| refused())?;
        let file = fs::symlink_metadata(self.root.join("owner.json")).map_err(|_| refused())?;
        if !parent.is_dir()
            || id(&parent) != self.record.parent
            || !socket.file_type().is_socket()
            || !private(&socket)
            || id(&socket) != self.record.socket
            || !file.is_file()
            || !private(&file)
            || file.nlink() != 1
            || id(&file) != self.record_id
            || file.len() != self.bytes.len() as u64
        {
            return Err(refused());
        }
        let mut current = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(self.root.join("owner.json"))
            .map_err(|_| refused())?;
        if id(&current.metadata().map_err(|_| refused())?) != self.record_id {
            return Err(refused());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut current)
            .take(8193)
            .read_to_end(&mut bytes)
            .map_err(|_| refused())?;
        if bytes != self.bytes {
            return Err(refused());
        }
        Ok(())
    }
    pub fn verify(&self) -> Result<(), CandidateError> {
        self.verify_files()?;
        let expected = &self.record.process;
        identity::verify(
            expected,
            &identity::observe(expected.pid).map_err(|_| refused())?,
            &expected.executable,
            expected.uid,
        )
        .map_err(|_| refused())
    }
    pub fn connect(&self) -> Result<UnixStream, CandidateError> {
        self.verify()?;
        // Nonblocking connect bounds a full or unresponsive listener backlog.
        let path = std::ffi::CString::new(
            self.root
                .join("control.sock")
                .as_os_str()
                .as_encoded_bytes(),
        )
        .map_err(|_| refused())?;
        // SAFETY: socket returns a fresh owned descriptor or -1.
        let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
        if fd < 0 {
            return Err(refused());
        }
        use std::os::fd::FromRawFd;
        // SAFETY: successful socket transfers this descriptor exactly once.
        let stream = unsafe { UnixStream::from_raw_fd(fd) };
        // SAFETY: fd is owned here; mark it close-on-exec before any further work.
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(refused());
        }
        stream.set_nonblocking(true).map_err(|_| refused())?;
        // SAFETY: sockaddr_un is plain C storage, populated before connect.
        let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        address.sun_family = libc::AF_UNIX as _;
        let bytes = path.as_bytes_with_nul();
        if bytes.len() > address.sun_path.len() {
            return Err(refused());
        }
        for (to, from) in address.sun_path.iter_mut().zip(bytes) {
            *to = *from as _;
        }
        // SAFETY: initialized address has a fixed valid length and remains live.
        let result = unsafe {
            libc::connect(
                fd,
                (&address as *const libc::sockaddr_un).cast(),
                std::mem::size_of_val(&address) as _,
            )
        };
        if result != 0 {
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINPROGRESS) {
                return Err(refused());
            }
            let mut poll = libc::pollfd {
                fd,
                events: libc::POLLOUT,
                revents: 0,
            };
            // SAFETY: poll receives one writable descriptor entry.
            if unsafe { libc::poll(&mut poll, 1, 5000) } <= 0
                || stream.take_error().map_err(|_| refused())?.is_some()
            {
                return Err(refused());
            }
        }
        stream.set_nonblocking(false).map_err(|_| refused())?;
        let observed = peer(&stream)?;
        let expected = &self.record.process;
        identity::verify(expected, &observed, &expected.executable, expected.uid)
            .map_err(|_| refused())?;
        self.verify()?;
        Ok(stream)
    }
}
pub(super) struct Publication {
    listener: UnixListener,
    pin: Pin,
    _lock: state::Lock,
}
impl Publication {
    pub fn bind(candidate: &Candidate, run: &str) -> Result<Self, CandidateError> {
        let root = root(candidate, run)?;
        state::private_directory(&root).map_err(|_| refused())?;
        let lock = state::Lock::acquire(&root).map_err(|_| refused())?;
        for name in ["control.sock", "owner.json"] {
            match fs::symlink_metadata(root.join(name)) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(refused()),
            }
        }
        let listener = UnixListener::bind(root.join("control.sock")).map_err(|_| refused())?;
        fs::set_permissions(root.join("control.sock"), fs::Permissions::from_mode(0o600))
            .map_err(|_| refused())?;
        listener.set_nonblocking(true).map_err(|_| refused())?;
        let record = Record {
            version: 1,
            candidate: candidate.checkout.clone(),
            run: run.into(),
            process: identity::observe(std::process::id() as i32)?,
            parent: id(&fs::symlink_metadata(&root).map_err(|_| refused())?),
            socket: id(&fs::symlink_metadata(root.join("control.sock")).map_err(|_| refused())?),
        };
        let bytes = serde_json::to_vec(&record).map_err(|_| refused())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(root.join("owner.json"))
            .map_err(|_| refused())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| refused())?;
        let record_id = id(&file.metadata().map_err(|_| refused())?);
        fs::File::open(&root)
            .and_then(|f| f.sync_all())
            .map_err(|_| refused())?;
        let pin = Pin {
            root,
            record,
            bytes,
            record_id,
        };
        pin.verify()?;
        Ok(Self {
            listener,
            pin,
            _lock: lock,
        })
    }
    pub fn fd(&self) -> RawFd {
        self.listener.as_raw_fd()
    }
    pub fn verify(&self) -> Result<(), CandidateError> {
        self.pin.verify()
    }
    pub fn accept(&self) -> Result<Option<UnixStream>, CandidateError> {
        self.verify()?;
        match self.listener.accept() {
            Ok((stream, _)) => {
                self.verify()?;
                if peer(&stream).is_err() {
                    return Ok(None);
                }
                // Normalize macOS's inherited O_NONBLOCK for callers. Framing
                // independently uses poll and per-call nonblocking I/O, so a
                // request need not be prewritten when this connection is accepted.
                if stream.set_nonblocking(false).is_err() {
                    return Ok(None);
                }
                Ok(Some(stream))
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) =>
            {
                Ok(None)
            }
            Err(_) => Err(refused()),
        }
    }
    pub fn finish(&mut self) -> Result<(), CandidateError> {
        self.verify()?;
        fs::remove_file(self.pin.root.join("control.sock")).map_err(|_| refused())?;
        fs::remove_file(self.pin.root.join("owner.json")).map_err(|_| refused())?;
        fs::File::open(&self.pin.root)
            .and_then(|f| f.sync_all())
            .map_err(|_| refused())
    }
}
fn remaining(deadline: Instant) -> Result<Duration, CandidateError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(refused)
}
// Poll deadlines remain valid after both peers half-close. On macOS changing
// SO_RCVTIMEO after that point returns EINVAL even with a buffered response.
fn wait_io(fd: RawFd, events: i16, deadline: Instant) -> Result<(), CandidateError> {
    loop {
        let budget = remaining(deadline)?;
        let milliseconds = budget
            .as_millis()
            .saturating_add(u128::from(budget.subsec_nanos() % 1_000_000 != 0));
        let mut entry = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        // SAFETY: poll receives one initialized entry for the caller-owned stream.
        let count = unsafe { libc::poll(&mut entry, 1, milliseconds.min(i32::MAX as u128) as i32) };
        if count > 0 {
            if entry.revents & libc::POLLNVAL != 0 {
                return Err(refused());
            }
            remaining(deadline)?;
            return Ok(());
        }
        if count < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return Err(refused());
        }
    }
}
fn receive(
    stream: &UnixStream,
    bytes: &mut [u8],
    deadline: Instant,
) -> Result<usize, CandidateError> {
    loop {
        wait_io(stream.as_raw_fd(), libc::POLLIN, deadline)?;
        // SAFETY: bytes is writable for its length, and the stream owns the FD.
        // MSG_DONTWAIT prevents a readiness race from escaping the deadline.
        let count = unsafe {
            libc::recv(
                stream.as_raw_fd(),
                bytes.as_mut_ptr().cast(),
                bytes.len(),
                libc::MSG_DONTWAIT,
            )
        };
        if count >= 0 {
            remaining(deadline)?;
            return Ok(count as usize);
        }
        if !matches!(
            std::io::Error::last_os_error().kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
        ) {
            return Err(refused());
        }
    }
}
pub(super) fn read<T: DeserializeOwned>(
    stream: &mut UnixStream,
    budget: Duration,
    limit: usize,
) -> Result<T, CandidateError> {
    let deadline = Instant::now() + budget;
    let mut prefix = [0; 4];
    read_exact(stream, &mut prefix, deadline)?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > limit {
        return Err(refused());
    }
    let mut bytes = Zeroizing::new(vec![0; length]);
    read_exact(stream, &mut bytes, deadline)?;
    if receive(stream, &mut [0], deadline)? != 0 {
        return Err(refused());
    }
    serde_json::from_slice(&bytes).map_err(|_| refused())
}
fn read_exact(
    stream: &UnixStream,
    mut bytes: &mut [u8],
    deadline: Instant,
) -> Result<(), CandidateError> {
    while !bytes.is_empty() {
        let n = receive(stream, bytes, deadline)?;
        if n == 0 {
            return Err(refused());
        }
        bytes = &mut bytes[n..];
    }
    Ok(())
}
pub(super) fn write<T: Serialize>(
    stream: &mut UnixStream,
    value: &T,
    budget: Duration,
) -> Result<(), CandidateError> {
    // Serialize directly into a fixed allocation: no intermediate private JSON
    // Vec or reallocating frame. serde parser scratch is not covered by this.
    let mut frame = Zeroizing::new(vec![0; 256 * 1024 + 4]);
    let length = {
        let mut cursor = std::io::Cursor::new(&mut frame[4..]);
        serde_json::to_writer(&mut cursor, value).map_err(|_| refused())?;
        cursor.position() as usize
    };
    if length == 0 {
        return Err(refused());
    }
    frame[..4].copy_from_slice(&(length as u32).to_be_bytes());
    let frame = &frame[..length + 4];
    let deadline = Instant::now() + budget;
    let mut offset = 0;
    while offset < frame.len() {
        wait_io(stream.as_raw_fd(), libc::POLLOUT, deadline)?;
        let bytes = &frame[offset..];
        // SAFETY: the slice is readable for its length and the stream owns the FD.
        // Nonblocking send preserves the deadline; NOSIGNAL keeps disconnect local.
        let n = unsafe {
            libc::send(
                stream.as_raw_fd(),
                bytes.as_ptr().cast(),
                bytes.len(),
                libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
            )
        };
        if n < 0
            && matches!(
                std::io::Error::last_os_error().kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
            )
        {
            continue;
        }
        if n <= 0 {
            return Err(refused());
        }
        remaining(deadline)?;
        offset += n as usize;
    }
    stream.shutdown(Shutdown::Write).map_err(|_| refused())
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;

/// Exclusive retirement guard shares the publisher's lock. Absence alone never
/// authorizes cleanup while a foreground owner can still publish or restore.
pub(super) struct Retired {
    root: PathBuf,
    identity: (u64, u64),
    lock_identity: (u64, u64),
    _lock: state::Lock,
}
impl Retired {
    pub fn acquire(candidate: &Candidate, run: &str) -> Result<Option<Self>, CandidateError> {
        let root = root(candidate, run)?;
        state::check_private_directory(&root)?;
        for name in ["control.sock", "owner.json"] {
            match fs::symlink_metadata(root.join(name)) {
                Ok(_) => return Ok(None),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(refused()),
            }
        }
        let identity = id(&fs::symlink_metadata(&root).map_err(|_| refused())?);
        let lock_identity =
            id(&fs::symlink_metadata(root.join("operation.lock")).map_err(|_| refused())?);
        let lock = state::Lock::acquire_existing(&root)?;
        if lock.identity()? != lock_identity {
            return Err(refused());
        }
        let guard = Self {
            root,
            identity,
            lock_identity,
            _lock: lock,
        };
        guard.verify()?;
        Ok(Some(guard))
    }
    pub fn verify(&self) -> Result<(), CandidateError> {
        state::check_private_directory(&self.root)?;
        if id(&fs::symlink_metadata(&self.root).map_err(|_| refused())?) != self.identity
            || id(&fs::symlink_metadata(self.root.join("operation.lock")).map_err(|_| refused())?)
                != self.lock_identity
        {
            return Err(refused());
        }
        for name in ["control.sock", "owner.json"] {
            match fs::symlink_metadata(self.root.join(name)) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(refused()),
            }
        }
        Ok(())
    }
}
