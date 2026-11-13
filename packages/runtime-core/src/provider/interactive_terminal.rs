//! Dedicated native-child terminal ownership. Private input arrives over fd 3;
//! it stays open afterward as a lifetime leash, including while the PTY is idle.
use crate::CandidateError;
use std::{
    collections::VecDeque,
    ffi::CStr,
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::{
            ffi::OsStrExt,
            fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
            net::UnixStream,
        },
    },
    path::Path,
    sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const QUEUE: usize = 64 * 1024;

/// One bounded resize request at a time, with a single last-value mailbox.
/// Network inspection never runs on the terminal I/O thread. The caller's
/// resize operation must have its own deadline; scope exit joins it.
pub(crate) fn with_resize_worker<R>(
    mut resize: impl FnMut(u16, u16) + Send,
    session: impl FnOnce(&dyn Fn(u16, u16)) -> R,
) -> R {
    let pending = AtomicU32::new(0);
    let done = AtomicBool::new(false);
    struct Stop<'a>(&'a AtomicBool);
    impl Drop for Stop<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }
    std::thread::scope(|scope| {
        let pending = &pending;
        let done = &done;
        scope.spawn(move || {
            let mut next = Instant::now();
            while !done.load(Ordering::Acquire) {
                if Instant::now() >= next {
                    let value = pending.swap(0, Ordering::AcqRel);
                    if value != 0 {
                        resize((value >> 16) as u16, value as u16);
                        next = Instant::now() + Duration::from_millis(250);
                    }
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        });
        let _stop = Stop(done);
        session(&|rows, cols| {
            pending.store((u32::from(rows) << 16) | u32::from(cols), Ordering::Release);
        })
    })
}
static OWNED: AtomicBool = AtomicBool::new(false);
static SIGNAL: AtomicI32 = AtomicI32::new(0);
extern "C" fn interrupted(signal: i32) {
    SIGNAL.store(signal, Ordering::Release);
}
fn refused() -> CandidateError {
    CandidateError::new(
        "interactive_terminal_refused",
        "Interactive exec requires the foreground terminal and a private frontend lifetime pipe.",
    )
}
fn lost() -> CandidateError {
    CandidateError::new(
        "session_cleanup_uncertain",
        "Interactive transport ended without complete process cleanup proof; its session receipt was retained.",
    )
}

struct Signals {
    previous: Vec<(i32, libc::sigaction)>,
}
impl Signals {
    fn new() -> Result<Self, CandidateError> {
        if OWNED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(refused());
        }
        let mut guard = Self {
            previous: Vec::new(),
        };
        SIGNAL.store(0, Ordering::Release);
        for signal in [
            libc::SIGINT,
            libc::SIGTERM,
            libc::SIGHUP,
            libc::SIGQUIT,
            libc::SIGTSTP,
        ] {
            // SAFETY: these C structs have valid zero representations; the
            // handler touches only a lock-free atomic and retains no pointers.
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = interrupted as *const () as usize;
            unsafe {
                libc::sigemptyset(&mut action.sa_mask);
            }
            if unsafe { libc::sigaction(signal, &action, &mut previous) } != 0 {
                return Err(refused());
            }
            guard.previous.push((signal, previous));
        }
        Ok(guard)
    }
}
impl Drop for Signals {
    fn drop(&mut self) {
        for (signal, previous) in &self.previous {
            // SAFETY: restore the exact disposition captured by this guard.
            unsafe {
                libc::sigaction(*signal, previous, std::ptr::null_mut());
            }
        }
        OWNED.store(false, Ordering::Release);
    }
}

pub struct Leash {
    file: File,
}
#[cfg(any(feature = "native-config-plan", test))]
pub(crate) struct ControlWatch {
    stop: std::sync::Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
#[cfg(any(feature = "native-config-plan", test))]
impl Drop for ControlWatch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
impl Leash {
    /// Close an admission connection when the frontend disappears. This keeps
    /// the live owner's existing client-disconnect guard effective while the
    /// native child is waiting for the bounded control reply.
    #[cfg(any(feature = "native-config-plan", test))]
    pub(crate) fn watch_control(
        &self,
        stream: &UnixStream,
    ) -> Result<ControlWatch, CandidateError> {
        self.check()?;
        let leash = Self {
            file: self.file.try_clone().map_err(|_| lost())?,
        };
        let stream = stream.try_clone().map_err(|_| lost())?;
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let thread = std::thread::Builder::new()
            .name("interactive-admission-leash".into())
            .spawn(move || {
                while !done.load(Ordering::Acquire) {
                    if leash.check().is_err() {
                        let _ = stream.shutdown(std::net::Shutdown::Both);
                        break;
                    }
                    let mut fd = libc::pollfd {
                        fd: leash.file.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    };
                    // SAFETY: the owned leash keeps its fd and this poll entry live.
                    unsafe {
                        libc::poll(&mut fd, 1, 50);
                    }
                }
            })
            .map_err(|_| lost())?;
        Ok(ControlWatch {
            stop,
            thread: Some(thread),
        })
    }
    /// The length prefix separates the private payload from the still-open
    /// lifetime pipe. No user input is ever carried on this descriptor.
    pub fn receive(fd: OwnedFd) -> Result<(Self, Zeroizing<Vec<u8>>), CandidateError> {
        let file = File::from(fd);
        super::private_input::validate_duplex(&file)?;
        // SAFETY: file retains this fd, and the dedicated child owns its read end.
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
        if flags < 0
            || unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
        {
            return Err(refused());
        }
        let mut leash = Self { file };
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut length = [0; 4];
        leash.read_until(&mut length, deadline)?;
        let length = u32::from_be_bytes(length) as usize;
        if length > super::private_input::MAX_RECEIVE_BYTES {
            return Err(refused());
        }
        let mut payload = Zeroizing::new(vec![0; length]);
        leash.read_until(&mut payload, deadline)?;
        leash.check()?;
        Ok((leash, payload))
    }
    fn read_until(
        &mut self,
        mut bytes: &mut [u8],
        deadline: Instant,
    ) -> Result<(), CandidateError> {
        while !bytes.is_empty() {
            if SIGNAL.load(Ordering::Acquire) != 0 || Instant::now() >= deadline {
                return Err(lost());
            }
            let mut fd = libc::pollfd {
                fd: self.file.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: a single live poll entry, bounded wait.
            if unsafe { libc::poll(&mut fd, 1, 50) } < 0
                && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
            {
                return Err(lost());
            }
            match self.file.read(bytes) {
                Ok(0) => return Err(lost()),
                Ok(n) => bytes = &mut bytes[n..],
                Err(e) if retry(&e) => (),
                Err(_) => return Err(lost()),
            }
        }
        Ok(())
    }
    pub fn check(&self) -> Result<(), CandidateError> {
        if SIGNAL.load(Ordering::Acquire) != 0 {
            return Err(lost());
        }
        let mut file = &self.file;
        match file.read(&mut [0]) {
            Err(e) if retry(&e) => Ok(()),
            _ => Err(lost()), // EOF, unexpected bytes, or a broken pipe.
        }
    }
}

pub struct Terminal {
    file: File,
    saved: libc::termios,
    raw: bool,
    _signals: Signals,
}
impl Terminal {
    /// Open the same terminal through a separate file description so our
    /// nonblocking flags cannot alter the frontend's inherited descriptors.
    pub fn open() -> Result<Self, CandidateError> {
        let signals = Signals::new()?;
        // SAFETY: isatty/getpgrp/tcgetpgrp are read-only kernel queries.
        if unsafe {
            libc::isatty(0) != 1 || libc::isatty(1) != 1 || libc::tcgetpgrp(0) != libc::getpgrp()
        } {
            return Err(refused());
        }
        let mut name = [0i8; 1024];
        // SAFETY: ttyname_r writes at most the provided buffer length.
        if unsafe { libc::ttyname_r(0, name.as_mut_ptr(), name.len()) } != 0 {
            return Err(refused());
        }
        let path = Path::new(std::ffi::OsStr::from_bytes(
            unsafe { CStr::from_ptr(name.as_ptr()) }.to_bytes(),
        ));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NOCTTY | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| refused())?;
        // SAFETY: fstat initializes input; fd 0 is borrowed, never closed here.
        let mut input: libc::stat = unsafe { std::mem::zeroed() };
        let mut output: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(0, &mut input) } != 0
            || unsafe { libc::fstat(1, &mut output) } != 0
            || input.st_rdev != output.st_rdev
        {
            return Err(refused());
        }
        let metadata = file.metadata().map_err(|_| refused())?;
        if !metadata.file_type().is_char_device() || metadata.rdev() != input.st_rdev as u64 {
            return Err(refused());
        }
        let mut saved: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(file.as_raw_fd(), &mut saved) } != 0 {
            return Err(refused());
        }
        Ok(Self {
            file,
            saved,
            raw: false,
            _signals: signals,
        })
    }
    pub fn size(&self) -> Result<(u16, u16), CandidateError> {
        let mut size: libc::winsize = unsafe { std::mem::zeroed() };
        // SAFETY: size is a writable winsize and this terminal is retained.
        if unsafe { libc::ioctl(self.file.as_raw_fd(), libc::TIOCGWINSZ, &mut size) } != 0 {
            return Err(refused());
        }
        Ok((size.ws_row.max(1), size.ws_col.max(1)))
    }
    pub fn restore(&mut self) -> Result<(), CandidateError> {
        if self.raw {
            // SAFETY: saved came from this terminal; no pointers are retained.
            if unsafe { libc::tcsetattr(self.file.as_raw_fd(), libc::TCSANOW, &self.saved) } != 0 {
                return Err(CandidateError::new(
                    "interactive_terminal_restore_failed",
                    "Terminal restoration failed; run stty sane in this terminal.",
                ));
            }
            self.raw = false;
        }
        Ok(())
    }
    /// Called only after the Engine attach and any private-env ACK. Queues are
    /// independently bounded; a large paste cannot block output or the leash.
    pub fn relay(
        &mut self,
        stream: &mut UnixStream,
        leash: &Leash,
        resize: &mut dyn FnMut(u16, u16),
    ) -> Result<(), CandidateError> {
        leash.check()?;
        let mut raw = self.saved;
        // SAFETY: raw is initialized termios for this exact retained terminal.
        unsafe {
            libc::cfmakeraw(&mut raw);
        }
        if unsafe { libc::tcsetattr(self.file.as_raw_fd(), libc::TCSANOW, &raw) } != 0 {
            return Err(refused());
        }
        self.raw = true;
        stream.set_nonblocking(true).map_err(|_| lost())?;
        let result = self.copy(stream, leash, resize);
        self.restore()?;
        result
    }
    fn copy(
        &mut self,
        stream: &mut UnixStream,
        leash: &Leash,
        resize: &mut dyn FnMut(u16, u16),
    ) -> Result<(), CandidateError> {
        let mut input = VecDeque::with_capacity(QUEUE);
        let mut output = VecDeque::with_capacity(QUEUE);
        let mut eof = false;
        let mut size = None;
        loop {
            leash.check()?;
            if let Ok(current) = self.size() {
                if size != Some(current) {
                    resize(current.0, current.1);
                    size = Some(current);
                }
            }
            if eof && output.is_empty() {
                return Ok(());
            }
            let mut fds = [
                libc::pollfd {
                    fd: self.file.as_raw_fd(),
                    events: (if !eof && input.len() < QUEUE {
                        libc::POLLIN
                    } else {
                        0
                    }) | if output.is_empty() { 0 } else { libc::POLLOUT },
                    revents: 0,
                },
                libc::pollfd {
                    fd: stream.as_raw_fd(),
                    events: (if !eof && output.len() < QUEUE {
                        libc::POLLIN
                    } else {
                        0
                    }) | if input.is_empty() || eof {
                        0
                    } else {
                        libc::POLLOUT
                    },
                    revents: 0,
                },
                libc::pollfd {
                    fd: leash.file.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            // SAFETY: exactly three initialized poll entries are writable here.
            if unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as _, 100) } < 0 {
                if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(lost());
            }
            leash.check()?;
            if fds[0].revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                return Err(lost());
            }
            if !eof
                && fds[0].revents & libc::POLLIN != 0
                && !read_queue(&mut self.file, &mut input)?
            {
                return Err(lost());
            }
            if !eof
                && fds[1].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0
                && output.len() < QUEUE
            {
                eof = !read_queue(stream, &mut output)?;
            }
            if fds[1].revents & libc::POLLNVAL != 0 {
                return Err(lost());
            }
            if fds[0].revents & libc::POLLOUT != 0 {
                write_queue(&mut self.file, &mut output)?;
            }
            if !eof && fds[1].revents & libc::POLLOUT != 0 {
                write_queue(stream, &mut input)?;
            }
        }
    }
}
impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}
fn retry(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}
fn read_queue(reader: &mut impl Read, queue: &mut VecDeque<u8>) -> Result<bool, CandidateError> {
    let mut bytes = [0; 4096];
    let limit = (QUEUE - queue.len()).min(bytes.len());
    if limit == 0 {
        return Ok(true);
    }
    match reader.read(&mut bytes[..limit]) {
        Ok(0) => Ok(false),
        Ok(n) => {
            queue.extend(&bytes[..n]);
            Ok(true)
        }
        Err(e) if retry(&e) => Ok(true),
        Err(_) => Err(lost()),
    }
}
fn write_queue(writer: &mut impl Write, queue: &mut VecDeque<u8>) -> Result<(), CandidateError> {
    let bytes = queue.as_slices().0;
    if bytes.is_empty() {
        return Ok(());
    }
    match writer.write(bytes) {
        Ok(0) => Err(lost()),
        Ok(n) => {
            queue.drain(..n);
            Ok(())
        }
        Err(e) if retry(&e) => Ok(()),
        Err(_) => Err(lost()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::FromRawFd;

    // Re-exec this one test so process-wide terminal and signal ownership cannot
    // affect the parallel Rust test runner. Only the PTY harness sets this mode.
    #[test]
    fn child_session() {
        let Ok(mode) = std::env::var("HACK_INTERACTIVE_CHILD") else {
            return;
        };
        let control: i32 = std::env::var("HACK_INTERACTIVE_CONTROL")
            .unwrap()
            .parse()
            .unwrap();
        let engine: i32 = std::env::var("HACK_INTERACTIVE_ENGINE")
            .unwrap()
            .parse()
            .unwrap();
        assert!(control > 2 && engine > 2 && control != engine);
        // SAFETY: the harness transferred these distinct inherited descriptors
        // to this dedicated process; neither has another Rust owner.
        let control = unsafe { OwnedFd::from_raw_fd(control) };
        let mut report = File::from(control.try_clone().unwrap());
        let mut engine = unsafe { UnixStream::from_raw_fd(engine) };
        let mut terminal = Terminal::open().unwrap();
        let (leash, payload) = Leash::receive(control).unwrap();
        assert!(payload.is_empty());
        let mut resized = false;
        let result = terminal.relay(&mut engine, &leash, &mut |rows, cols| {
            if (rows, cols) == (43, 91) && !resized {
                report.write_all(b"R").unwrap();
                resized = true;
            }
        });
        if mode == "flood" {
            assert!(result.is_ok());
            assert!(resized);
        } else {
            assert_eq!(result.unwrap_err().code, "session_cleanup_uncertain");
        }
        terminal.restore().unwrap();
        report.write_all(b"D").unwrap();
    }

    #[test]
    fn process_terminal_contract() {
        let output = std::process::Command::new("python3")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../tests/fixtures/native-interactive-terminal.py"
            ))
            .arg(std::env::current_exe().unwrap())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "Native terminal: flood, resize, idle leash and signal restoration passed\n"
        );
    }

    #[test]
    fn idle_frontend_loss_closes_pending_owner_admission() {
        let (input, mut frontend) = UnixStream::pair().unwrap();
        frontend.write_all(&[0; 4]).unwrap();
        let (leash, _) = Leash::receive(input.into()).unwrap();
        let (control, mut owner) = UnixStream::pair().unwrap();
        let watch = leash.watch_control(&control).unwrap();
        drop(frontend);
        owner
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        assert_eq!(owner.read(&mut [0]).unwrap(), 0);
        drop(watch);
    }

    #[test]
    fn slow_resize_never_blocks_input_and_coalesces_to_latest() {
        let (seen, observed) = std::sync::mpsc::channel();
        let (release, allowed) = std::sync::mpsc::channel();
        with_resize_worker(
            move |rows, cols| {
                seen.send((rows, cols)).unwrap();
                if rows == 1 {
                    allowed.recv_timeout(Duration::from_secs(2)).unwrap();
                }
            },
            |notify| {
                notify(1, 1);
                assert_eq!(
                    observed.recv_timeout(Duration::from_secs(1)).unwrap(),
                    (1, 1)
                );
                // The first request remains blocked while the I/O caller progresses.
                for n in 2..=1000 {
                    notify(n, n);
                }
                release.send(()).unwrap();
                assert_eq!(
                    observed.recv_timeout(Duration::from_secs(2)).unwrap(),
                    (1000, 1000)
                );
                assert!(observed.try_recv().is_err());
            },
        );
    }
}
