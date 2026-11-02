//! Container-local TCP admission only. Every accepted stream authenticates through
//! the canonical client before it consumes application bytes.
use crate::{CandidateError, relay_auth::Credential, relay_client, socket};
use std::{
    fs,
    io::{self, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    os::{fd::AsRawFd, unix::net::UnixStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI32, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};
const MAX_ACTIVE: usize = 32;
static SIGNAL_FD: AtomicI32 = AtomicI32::new(-1);
static STOP: AtomicBool = AtomicBool::new(false);
fn refused() -> CandidateError {
    CandidateError::new("relay_guest_server", "Guest relay listener failed.")
}

extern "C" fn stop_signal(_: libc::c_int) {
    // Only lock-free atomics and async-signal-safe write occur in this handler.
    // SAFETY: these libc accessors return the calling thread's errno location.
    #[cfg(target_os = "linux")]
    let errno = unsafe { libc::__errno_location() };
    // SAFETY: the macOS accessor has the same thread-local lifetime contract.
    #[cfg(target_os = "macos")]
    let errno = unsafe { libc::__error() };
    // SAFETY: the platform errno accessor returns this thread's live errno cell.
    let saved = unsafe { *errno };
    STOP.store(true, Ordering::Release);
    let fd = SIGNAL_FD.load(Ordering::Acquire);
    if fd >= 0 {
        let byte = 1u8;
        // SAFETY: SignalGuard keeps this nonblocking descriptor live until all
        // workers join and previous signal handlers have been restored.
        unsafe {
            libc::write(fd, (&byte as *const u8).cast(), 1);
        }
    }
    // SAFETY: restoring the same thread-local errno preserves interrupted I/O.
    unsafe {
        *errno = saved;
    }
}
struct BlockSignals {
    previous: libc::sigset_t,
}
impl BlockSignals {
    fn new() -> Result<Self, CandidateError> {
        // SAFETY: sigset_t is initialized through libc before use.
        let mut signals: libc::sigset_t = unsafe { std::mem::zeroed() };
        // SAFETY: this plain C output storage is filled by pthread_sigmask.
        let mut previous: libc::sigset_t = unsafe { std::mem::zeroed() };
        // SAFETY: signals points to writable sigset_t storage.
        unsafe {
            libc::sigemptyset(&mut signals);
            libc::sigaddset(&mut signals, libc::SIGTERM);
            libc::sigaddset(&mut signals, libc::SIGINT);
        }
        // SAFETY: both pointers are valid initialized signal-set storage.
        if unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &signals, &mut previous) } != 0 {
            return Err(refused());
        }
        Ok(Self { previous })
    }
}
impl Drop for BlockSignals {
    fn drop(&mut self) {
        // SAFETY: previous is the saved mask for this thread.
        unsafe {
            libc::pthread_sigmask(libc::SIG_SETMASK, &self.previous, std::ptr::null_mut());
        }
    }
}
struct SignalGuard {
    reader: UnixStream,
    writer: Arc<UnixStream>,
    previous: Vec<(i32, libc::sigaction)>,
    installed: bool,
}
impl SignalGuard {
    fn new() -> Result<Self, CandidateError> {
        let _blocked = BlockSignals::new()?;
        let (reader, writer) = UnixStream::pair().map_err(|_| refused())?;
        reader.set_nonblocking(true).map_err(|_| refused())?;
        writer.set_nonblocking(true).map_err(|_| refused())?;
        if SIGNAL_FD
            .compare_exchange(-1, writer.as_raw_fd(), Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(refused());
        }
        STOP.store(false, Ordering::Release);
        let mut guard = Self {
            reader,
            writer: Arc::new(writer),
            previous: Vec::new(),
            installed: true,
        };
        for signal in [libc::SIGTERM, libc::SIGINT] {
            // SAFETY: sigaction is plain C storage; mask is initialized before install.
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            // SAFETY: sigaction fills this plain C output storage.
            let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = stop_signal as *const () as usize;
            // SAFETY: action owns the writable signal mask being initialized.
            unsafe {
                libc::sigemptyset(&mut action.sa_mask);
            }
            // SAFETY: kernel copies action and writes the previous action into live storage.
            if unsafe { libc::sigaction(signal, &action, &mut previous) } != 0 {
                return Err(refused());
            }
            guard.previous.push((signal, previous));
        }
        Ok(guard)
    }
    fn drain(&mut self) -> Result<(), CandidateError> {
        let mut bytes = [0; 128];
        for _ in 0..8 {
            match self.reader.read(&mut bytes) {
                Ok(0) => return Err(refused()),
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                Err(_) => return Err(refused()),
            }
        }
        Ok(())
    }
}
impl Drop for SignalGuard {
    fn drop(&mut self) {
        if !self.installed {
            return;
        }
        // Server is declared after this guard and joins all workers before drop.
        // Thus masking this final thread prevents a stale handler touching a reused FD.
        let _blocked = BlockSignals::new().ok();
        for (signal, previous) in self.previous.iter().rev() {
            // SAFETY: previous is exactly the saved disposition for signal.
            unsafe {
                libc::sigaction(*signal, previous, std::ptr::null_mut());
            }
        }
        SIGNAL_FD.store(-1, Ordering::Release);
        self.installed = false;
    }
}
struct Controls {
    application: Option<TcpStream>,
    transport: Option<UnixStream>,
    canceled: bool,
}
impl Controls {
    fn cancel(&mut self) {
        self.canceled = true;
        if let Some(stream) = &self.application {
            let _ = stream.shutdown(Shutdown::Both);
        }
        if let Some(stream) = &self.transport {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}
struct Completion {
    controls: Arc<Mutex<Controls>>,
    done: Arc<AtomicBool>,
    wake: Arc<UnixStream>,
}
impl Drop for Completion {
    fn drop(&mut self) {
        let mut controls = self.controls.lock().unwrap_or_else(|p| p.into_inner());
        // Cancellation duplicates must not prolong normal EOF after the worker ends.
        controls.application.take();
        controls.transport.take();
        drop(controls);
        // Set completion before notification. is_finished() could race the last wake.
        self.done.store(true, Ordering::Release);
        let byte = 1u8;
        // SAFETY: wake is owned here and the main guard retains its reader. EAGAIN
        // is harmless because a full wake channel is already readable.
        unsafe {
            libc::write(self.wake.as_raw_fd(), (&byte as *const u8).cast(), 1);
        }
    }
}
struct Worker {
    controls: Arc<Mutex<Controls>>,
    done: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}
struct Server {
    listener: Option<TcpListener>,
    workers: Vec<Worker>,
}
impl Server {
    fn reap(&mut self) -> Result<(), CandidateError> {
        let mut i = 0;
        while i < self.workers.len() {
            if self.workers[i].done.load(Ordering::Acquire) {
                let worker = self.workers.swap_remove(i);
                worker.handle.join().map_err(|_| refused())?;
            } else {
                i += 1;
            }
        }
        Ok(())
    }
    fn launch(
        &mut self,
        application: TcpStream,
        slot: u8,
        credential: Arc<Credential>,
        wake: Arc<UnixStream>,
    ) -> Result<(), CandidateError> {
        let controls = Arc::new(Mutex::new(Controls {
            application: Some(application.try_clone().map_err(|_| refused())?),
            transport: None,
            canceled: false,
        }));
        let done = Arc::new(AtomicBool::new(false));
        let completion = Completion {
            controls: Arc::clone(&controls),
            done: Arc::clone(&done),
            wake,
        };
        let handle = thread::Builder::new()
            .name("dependency-relay".into())
            .spawn(move || {
                let _blocked = BlockSignals::new().ok();
                let result = (|| {
                    // Connect holds no mutex; shutdown may wait at most this five-second budget.
                    let transport = socket::connect(slot, Duration::from_secs(5))?;
                    {
                        let mut controls = completion
                            .controls
                            .lock()
                            .unwrap_or_else(|p| p.into_inner());
                        if controls.canceled || STOP.load(Ordering::Acquire) {
                            return Err(refused());
                        }
                        controls.transport = Some(transport.try_clone().map_err(|_| refused())?);
                    }
                    relay_client::run(
                        transport,
                        application,
                        &credential,
                        relay_client::Limits {
                            handshake_timeout: Duration::from_secs(5),
                            idle_timeout: Duration::from_secs(30),
                        },
                    )?;
                    Ok::<(), CandidateError>(())
                })();
                // Individual failures close only their connection and never log payloads.
                drop(result);
                drop(completion);
            })
            .map_err(|_| refused())?;
        self.workers.push(Worker {
            controls,
            done,
            handle,
        });
        Ok(())
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.listener.take();
        for worker in &self.workers {
            worker
                .controls
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .cancel();
        }
        for worker in self.workers.drain(..) {
            let _ = worker.handle.join();
        }
    }
}
fn process_start() -> Result<u64, CandidateError> {
    let value = fs::read_to_string("/proc/self/stat").map_err(|_| refused())?;
    let fields = value.rsplit_once(')').ok_or_else(refused)?.1;
    fields
        .split_whitespace()
        .nth(19)
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .ok_or_else(refused)
}
pub(super) fn run(
    slot: u8,
    address: std::net::Ipv4Addr,
    port: u16,
    credential: Credential,
) -> Result<(), CandidateError> {
    if !crate::options::valid_address(slot, address) || port == 0 {
        return Err(refused());
    }
    let mut signals = SignalGuard::new()?;
    let listener = TcpListener::bind((address, port)).map_err(|_| refused())?;
    listener.set_nonblocking(true).map_err(|_| refused())?;
    let mut server = Server {
        listener: Some(listener),
        workers: Vec::new(),
    };
    let credential = Arc::new(credential);
    let marker = if address == std::net::Ipv4Addr::LOCALHOST {
        format!(
            "hack-relay-listener-v1 pid={} start={} port={port}",
            std::process::id(),
            process_start()?
        )
    } else {
        format!(
            "hack-relay-listener-v2 pid={} start={} address={address} port={port}",
            std::process::id(),
            process_start()?
        )
    };
    writeln!(io::stdout().lock(), "{marker}").map_err(|_| refused())?;
    io::stdout().flush().map_err(|_| refused())?;
    while !STOP.load(Ordering::Acquire) {
        server.reap()?;
        let mut fds = [
            libc::pollfd {
                fd: server.listener.as_ref().ok_or_else(refused)?.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: signals.reader.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // SAFETY: both descriptors and the writable array remain live for the call.
        let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, -1) };
        if ready < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(refused());
        }
        if fds
            .iter()
            .any(|p| p.revents & (libc::POLLERR | libc::POLLNVAL | libc::POLLHUP) != 0)
        {
            return Err(refused());
        }
        if fds[1].revents & libc::POLLIN != 0 {
            signals.drain()?;
            server.reap()?;
        }
        if STOP.load(Ordering::Acquire) {
            break;
        }
        if fds[0].revents & libc::POLLIN != 0 {
            // One accept per turn keeps signal/completion handling responsive under load.
            match server.listener.as_ref().ok_or_else(refused)?.accept() {
                Ok((application, _)) if server.workers.len() < MAX_ACTIVE => server.launch(
                    application,
                    slot,
                    Arc::clone(&credential),
                    Arc::clone(&signals.writer),
                )?,
                Ok((application, _)) => {
                    let _ = application.shutdown(Shutdown::Both);
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => return Err(refused()),
            }
        }
    }
    // Explicit order: cancel/join before restoring handlers or closing the wake FD.
    drop(server);
    drop(signals);
    Ok(())
}
