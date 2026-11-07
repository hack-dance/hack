//! A private host relay between the build client and the provider's forwarded engine
//! socket.
//!
//! The pinned provider forwards the guest engine socket to the host through its vsock
//! muxer. On macOS that muxer can enter a permanent busy loop when the host peer of a
//! forwarded connection goes away while the guest is still sending on it: the send fails,
//! the stream is reset, a later credit update from the guest re-arms it with only write
//! interest, and deleting that interest fails (one `kevent` change list stops at the
//! unregistered read filter). The dead socket then reports a hang-up on every wait, each
//! one queues another reset to the guest and restarts the stream's reaper delay, so the
//! stream is never removed. The guest's vCPUs and the shared vsock queue stay saturated
//! and every later agent or engine request times out.
//!
//! The BuildKit client closes many connections before reading the whole response, and
//! closes the rest at exit, so builds reached that state in most runs. The relay keeps the
//! provider-side connection away from it with three rules:
//!
//! - Provider bytes are always read promptly, including after the client has gone (they
//!   are then counted and discarded), so the provider never sees a failed send.
//! - The client's end of stream reaches the provider only as a half-close, after every
//!   byte the client sent was delivered.
//! - The relay closes a provider-side connection only after the provider reported end of
//!   stream, which means the guest side finished. [`ClientRelay::finish`] bounds that wait
//!   and then closes what is left, counting it in [`RelayReport::forced`].
//!
//! The listening socket lives in a fresh mode-0700 directory under the system temporary
//! root, so its path fits `sockaddr_un` and only this user can connect. It accepts only
//! while the client runs; nothing else is relayed and no bytes are inspected or logged.
use crate::CandidateError;
use std::{
    fs::{self, File},
    io::{ErrorKind, Read, Write},
    os::fd::AsRawFd,
    os::unix::{
        fs::{DirBuilderExt, MetadataExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

/// How long [`ClientRelay::finish`] waits for the guest to end its connections.
pub(super) const FINISH_GRACE: Duration = Duration::from_secs(10);
const TICK: Duration = Duration::from_millis(50);
const CHUNK: usize = 64 * 1024;
/// Client bytes not yet delivered; reading the client pauses above this.
const TO_PROVIDER_LIMIT: usize = 1024 * 1024;
/// Provider bytes not yet delivered to a live client; reading the provider pauses above
/// this only while the client is still connected but not reading.
const TO_CLIENT_LIMIT: usize = 16 * 1024 * 1024;
/// A larger receive buffer lets the provider's sends complete at once instead of
/// queueing in the provider.
const PROVIDER_RECEIVE_BUFFER: libc::c_int = 4 * 1024 * 1024;
const SOCKET_NAME: &str = "engine.sock";

/// What the relay did, for tests and diagnostics. It carries no payload bytes.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct RelayReport {
    /// Client connections accepted.
    pub connections: u32,
    /// Provider bytes read after the client had gone.
    pub discarded_bytes: u64,
    /// Connections closed by the bound in `finish` before the provider ended them.
    pub forced: u32,
    /// Client connections dropped because the provider socket refused the connection.
    pub refused: u32,
}

struct Shared {
    stop: AtomicBool,
    force: AtomicBool,
    report: Mutex<RelayReport>,
    connections: Mutex<Vec<JoinHandle<()>>>,
}

impl Shared {
    fn update(&self, change: impl FnOnce(&mut RelayReport)) {
        // A poisoned lock means a connection thread panicked; the counts stay usable.
        let mut report = self
            .report
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        change(&mut report);
    }
}

/// A running relay. Call [`ClientRelay::finish`] once the client has exited.
pub(super) struct ClientRelay {
    directory: PathBuf,
    socket: PathBuf,
    shared: Arc<Shared>,
    acceptor: Option<JoinHandle<()>>,
}

impl ClientRelay {
    /// Listen on a fresh private socket and relay each connection to `provider`.
    /// Connecting to `provider` happens per client connection, so starting never touches
    /// the engine.
    pub(super) fn start(provider: &Path) -> Result<Self, CandidateError> {
        Self::start_in(temporary_root(), provider)
    }

    /// [`Self::start`] with its private directory (and the sweep of abandoned ones) under
    /// `root` instead of the temporary directory; tests give each relay its own root.
    fn start_in(root: &Path, provider: &Path) -> Result<Self, CandidateError> {
        let directory = private_directory(root)?;
        let socket = directory.join(SOCKET_NAME);
        let shared = Arc::new(Shared {
            stop: AtomicBool::new(false),
            force: AtomicBool::new(false),
            report: Mutex::new(RelayReport::default()),
            connections: Mutex::new(Vec::new()),
        });
        // From here on, dropping `relay` removes the socket and its directory.
        let mut relay = Self {
            directory,
            socket,
            shared,
            acceptor: None,
        };
        let listener = UnixListener::bind(&relay.socket)
            .and_then(|listener| listener.set_nonblocking(true).map(|()| listener))
            .map_err(|_| failure("Cannot listen for the build client."))?;
        let provider = provider.to_path_buf();
        let accepting = Arc::clone(&relay.shared);
        relay.acceptor = Some(
            std::thread::Builder::new()
                .name("build-client-relay".into())
                .spawn(move || accept(&listener, &provider, &accepting))
                .map_err(|_| failure("Cannot start the build client relay."))?,
        );
        Ok(relay)
    }

    /// The socket the client connects to.
    pub(super) fn socket(&self) -> &Path {
        &self.socket
    }

    /// Stop accepting, then wait up to `grace` for the provider to end every relayed
    /// connection, closing any that remain after it.
    pub(super) fn finish(mut self, grace: Duration) -> RelayReport {
        self.stop(grace)
    }

    fn stop(&mut self, grace: Duration) -> RelayReport {
        self.shared.stop.store(true, Ordering::Release);
        if let Some(acceptor) = self.acceptor.take() {
            let _ = acceptor.join();
        }
        let _ = fs::remove_file(&self.socket);
        let _ = fs::remove_dir(&self.directory);
        let connections = std::mem::take(
            &mut *self
                .shared
                .connections
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        let deadline = Instant::now() + grace;
        while connections.iter().any(|handle| !handle.is_finished()) && Instant::now() < deadline {
            std::thread::sleep(TICK);
        }
        self.shared.force.store(true, Ordering::Release);
        for handle in connections {
            let _ = handle.join();
        }
        *self
            .shared
            .report
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Drop for ClientRelay {
    fn drop(&mut self) {
        if self.acceptor.is_some() {
            // Only an early return reaches this; the client has already been stopped.
            self.stop(FINISH_GRACE);
        } else {
            let _ = fs::remove_file(&self.socket);
            let _ = fs::remove_dir(&self.directory);
        }
    }
}

fn failure(message: &str) -> CandidateError {
    CandidateError::new("native_build_client", message)
}

const DIRECTORY_PREFIX: &str = "hkb-";

fn temporary_root() -> &'static Path {
    if cfg!(target_os = "macos") {
        Path::new("/private/tmp")
    } else {
        Path::new("/tmp")
    }
}

/// A new mode-0700 directory with a short path under `parent`, owned by this user. Its
/// name carries this process's PID, so a later relay can remove what a killed process
/// left behind.
fn private_directory(parent: &Path) -> Result<PathBuf, CandidateError> {
    remove_abandoned(parent);
    for _ in 0..8 {
        let mut bytes = [0_u8; 6];
        File::open("/dev/urandom")
            .and_then(|mut random| random.read_exact(&mut bytes))
            .map_err(|_| failure("Cannot choose a private build client socket."))?;
        let name: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let directory = parent.join(format!("{DIRECTORY_PREFIX}{}-{name}", std::process::id()));
        match fs::DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(failure("Cannot create a private build client socket.")),
        }
        let metadata = fs::symlink_metadata(&directory)
            .map_err(|_| failure("Cannot inspect the private build client socket."))?;
        // SAFETY: geteuid has no preconditions.
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o777 != 0o700
        {
            return Err(failure(
                "The private build client socket directory is not private.",
            ));
        }
        return Ok(directory);
    }
    Err(failure("Cannot create a private build client socket."))
}

/// Remove relay directories whose creating process is gone (it was killed before it
/// could clean up). Only a mode-0700 directory owned by this user, named for a PID that
/// no longer exists and holding nothing but the relay socket, is removed; anything else
/// is left alone. A reused PID only keeps a stale directory longer.
fn remove_abandoned(parent: &Path) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    // SAFETY: geteuid has no preconditions.
    let user = unsafe { libc::geteuid() };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name
            .to_str()
            .and_then(|name| name.strip_prefix(DIRECTORY_PREFIX))
            .and_then(|rest| rest.split_once('-'))
            .and_then(|(pid, _)| pid.parse::<libc::pid_t>().ok())
            .filter(|pid| *pid > 0)
        else {
            continue;
        };
        // SAFETY: signal 0 only checks for existence; no signal is delivered.
        let gone = unsafe { libc::kill(pid, 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        let directory = entry.path();
        let private = fs::symlink_metadata(&directory).is_ok_and(|metadata| {
            metadata.is_dir() && metadata.uid() == user && metadata.mode() & 0o777 == 0o700
        });
        if !gone || !private {
            continue;
        }
        let socket = directory.join(SOCKET_NAME);
        if fs::symlink_metadata(&socket).is_ok_and(|metadata| {
            use std::os::unix::fs::FileTypeExt;
            metadata.file_type().is_socket() && metadata.uid() == user
        }) {
            let _ = fs::remove_file(&socket);
        }
        // Fails, and keeps the directory, unless it is now empty.
        let _ = fs::remove_dir(&directory);
    }
}

fn accept(listener: &UnixListener, provider: &Path, shared: &Arc<Shared>) {
    while !shared.stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((client, _)) => {
                shared.update(|report| report.connections += 1);
                let Ok(upstream) = connect(provider) else {
                    shared.update(|report| report.refused += 1);
                    continue;
                };
                let relaying = Arc::clone(shared);
                let spawned = std::thread::Builder::new()
                    .name("build-client-connection".into())
                    .spawn(move || {
                        if let Ok(mut connection) = Connection::new(client, upstream) {
                            connection.run(&relaying);
                        }
                    });
                if let Ok(handle) = spawned {
                    shared
                        .connections
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .push(handle);
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => std::thread::sleep(TICK),
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(_) => std::thread::sleep(TICK),
        }
    }
}

fn connect(provider: &Path) -> std::io::Result<UnixStream> {
    let stream = UnixStream::connect(provider)?;
    // SAFETY: the stream owns this live descriptor for the call; `size` points to a
    // readable native int of the option's size. A refused size only loses headroom.
    unsafe {
        libc::setsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_RCVBUF,
            (&PROVIDER_RECEIVE_BUFFER as *const libc::c_int).cast(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        );
    }
    Ok(stream)
}

/// Pending bytes for one direction. Storage follows the bytes still pending, not the
/// traffic: the delivered prefix is dropped before it outgrows what remains, so the
/// buffer stays within about twice the pending bytes plus one read.
#[derive(Default)]
struct Pending {
    bytes: Vec<u8>,
    start: usize,
}

impl Pending {
    fn len(&self) -> usize {
        self.bytes.len() - self.start
    }
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    fn push(&mut self, bytes: &[u8]) {
        // Dropping the delivered prefix once it is at least half the buffer moves each
        // byte at most once more, so the cost stays linear in the traffic.
        if self.start > 0 && self.start >= self.bytes.len() / 2 {
            self.bytes.drain(..self.start);
            self.start = 0;
        }
        self.bytes.extend_from_slice(bytes);
    }
    fn clear(&mut self) {
        self.bytes.clear();
        self.start = 0;
    }
    /// Write what `stream` accepts now. `Err` means the peer can take no more.
    fn flush(&mut self, stream: &mut impl Write) -> Result<(), ()> {
        while !self.is_empty() {
            match stream.write(&self.bytes[self.start..]) {
                Ok(0) => return Err(()),
                Ok(count) => self.start += count,
                Err(error) if error.kind() == ErrorKind::WouldBlock => return Ok(()),
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(_) => return Err(()),
            }
        }
        if self.start == self.bytes.len() {
            self.clear();
        }
        Ok(())
    }
}

enum Received {
    Data(usize),
    End,
    Again,
}

fn read_some(stream: &mut UnixStream, buffer: &mut [u8]) -> Received {
    loop {
        match stream.read(buffer) {
            Ok(0) => return Received::End,
            Ok(count) => return Received::Data(count),
            Err(error) if error.kind() == ErrorKind::WouldBlock => return Received::Again,
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            // A reset ends the stream like an orderly end of stream.
            Err(_) => return Received::End,
        }
    }
}

/// One relayed connection. `client_*` is the build client's side, `provider_*` the
/// provider's forwarded engine socket.
struct Connection {
    client: UnixStream,
    provider: UnixStream,
    to_provider: Pending,
    to_client: Pending,
    /// The client sent end of stream or can no longer be read.
    client_ended: bool,
    /// The client can no longer receive; provider bytes are discarded.
    client_gone: bool,
    /// The provider's end of stream was forwarded to the client.
    client_closed_write: bool,
    /// The provider reported end of stream: the guest side finished sending.
    provider_ended: bool,
    /// The provider can no longer receive.
    provider_gone: bool,
    /// The client's end of stream was forwarded to the provider.
    provider_closed_write: bool,
    /// Provider bytes that could not reach the client because it had gone.
    discarded: u64,
}

impl Connection {
    fn new(client: UnixStream, provider: UnixStream) -> std::io::Result<Self> {
        client.set_nonblocking(true)?;
        provider.set_nonblocking(true)?;
        Ok(Self {
            client,
            provider,
            to_provider: Pending::default(),
            to_client: Pending::default(),
            client_ended: false,
            client_gone: false,
            client_closed_write: false,
            provider_ended: false,
            provider_gone: false,
            provider_closed_write: false,
            discarded: 0,
        })
    }

    fn done(&self) -> bool {
        self.provider_ended
            && (self.to_provider.is_empty() || self.provider_gone)
            && (self.to_client.is_empty() || self.client_gone)
    }

    fn run(&mut self, shared: &Shared) {
        let forced = self.relay(shared);
        let discarded = self.discarded;
        shared.update(|report| {
            report.discarded_bytes += discarded;
            report.forced += u32::from(forced);
        });
    }

    /// Relay until the connection is done; `true` when `finish` closed it first.
    fn relay(&mut self, shared: &Shared) -> bool {
        let mut buffer = vec![0_u8; CHUNK];
        while !self.done() {
            if shared.force.load(Ordering::Acquire) {
                return true;
            }
            let client_events = self.client_events();
            let provider_events = self.provider_events();
            let mut descriptors = [
                libc::pollfd {
                    // poll ignores a negative descriptor, so an idle side cannot wake it.
                    fd: if client_events == 0 {
                        -1
                    } else {
                        self.client.as_raw_fd()
                    },
                    events: client_events,
                    revents: 0,
                },
                libc::pollfd {
                    fd: if provider_events == 0 {
                        -1
                    } else {
                        self.provider.as_raw_fd()
                    },
                    events: provider_events,
                    revents: 0,
                },
            ];
            // SAFETY: `descriptors` is live, writable storage for two entries, and both
            // non-negative descriptors are owned by this connection for the call.
            let ready = unsafe {
                libc::poll(
                    descriptors.as_mut_ptr(),
                    descriptors.len() as libc::nfds_t,
                    TICK.as_millis() as libc::c_int,
                )
            };
            if ready <= 0 {
                continue;
            }
            let woke = |entry: &libc::pollfd, wanted: libc::c_short| {
                entry.revents & (wanted | libc::POLLHUP | libc::POLLERR) != 0
            };
            if woke(&descriptors[1], libc::POLLIN) && !self.provider_ended {
                self.read_provider(&mut buffer);
            }
            if woke(&descriptors[0], libc::POLLIN) && !self.client_ended {
                self.read_client(&mut buffer);
            }
            if woke(&descriptors[1], libc::POLLOUT)
                && !self.provider_gone
                && self.to_provider.flush(&mut self.provider).is_err()
            {
                self.provider_gone = true;
                self.to_provider.clear();
            }
            if woke(&descriptors[0], libc::POLLOUT) && !self.client_gone {
                self.flush_client();
            }
            self.forward_ends();
        }
        false
    }

    fn client_events(&self) -> libc::c_short {
        let mut events = 0;
        if !self.client_ended && self.to_provider.len() < TO_PROVIDER_LIMIT {
            events |= libc::POLLIN;
        }
        if !self.client_gone && !self.to_client.is_empty() {
            events |= libc::POLLOUT;
        }
        events
    }

    fn provider_events(&self) -> libc::c_short {
        let mut events = 0;
        // Provider bytes are read whenever they can be kept or discarded: this is what
        // keeps the provider's sends from failing or queueing.
        if !self.provider_ended && (self.client_gone || self.to_client.len() < TO_CLIENT_LIMIT) {
            events |= libc::POLLIN;
        }
        if !self.provider_gone && !self.to_provider.is_empty() {
            events |= libc::POLLOUT;
        }
        events
    }

    fn read_provider(&mut self, buffer: &mut [u8]) {
        match read_some(&mut self.provider, buffer) {
            Received::Data(count) if self.client_gone => self.discarded += count as u64,
            Received::Data(count) => {
                self.to_client.push(&buffer[..count]);
                self.flush_client();
            }
            Received::End => self.provider_ended = true,
            Received::Again => {}
        }
    }

    fn read_client(&mut self, buffer: &mut [u8]) {
        match read_some(&mut self.client, buffer) {
            Received::Data(count) => {
                self.to_provider.push(&buffer[..count]);
                if !self.provider_gone && self.to_provider.flush(&mut self.provider).is_err() {
                    self.provider_gone = true;
                    self.to_provider.clear();
                }
            }
            Received::End => self.client_ended = true,
            Received::Again => {}
        }
    }

    fn flush_client(&mut self) {
        if self.to_client.flush(&mut self.client).is_err() {
            self.client_gone = true;
            self.client_ended = true;
            self.discarded += self.to_client.len() as u64;
            self.to_client.clear();
        }
    }

    /// Forward each side's end of stream as a half-close once its bytes were delivered.
    fn forward_ends(&mut self) {
        if self.client_ended
            && !self.provider_closed_write
            && (self.to_provider.is_empty() || self.provider_gone)
        {
            self.provider_closed_write = true;
            let _ = self.provider.shutdown(std::net::Shutdown::Write);
        }
        if self.provider_ended
            && !self.client_closed_write
            && !self.client_gone
            && self.to_client.is_empty()
        {
            self.client_closed_write = true;
            let _ = self.client.shutdown(std::net::Shutdown::Write);
        }
    }
}

#[cfg(test)]
mod tests;
