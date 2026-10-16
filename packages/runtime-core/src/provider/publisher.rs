//! Native publisher shutdown proof. Callers retain intent and files until this succeeds.
pub use super::identity::ProcessIdentity;
use crate::CandidateError;
use std::path::Path;

pub struct StopOptions<'a> {
    pub process: &'a ProcessIdentity,
    pub binary: &'a Path,
    pub control: &'a Path,
    pub token: &'a str,
}
#[derive(Debug, PartialEq, Eq)]
pub enum StopOutcome {
    AlreadyAbsent,
    Exited,
}
fn refused() -> CandidateError {
    CandidateError::new(
        "publisher_stop_uncertain",
        "Publisher shutdown is unconfirmed; retain its intent and owned files.",
    )
}

/// Send a private stop request only after binding a native exit watch to exact identity.
/// Success proves process absence/exit, not receipt retirement or filesystem cleanup.
#[cfg(target_os = "macos")]
pub fn stop(options: StopOptions<'_>) -> Result<StopOutcome, CandidateError> {
    use super::{identity, state};
    use std::{
        fs,
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::{
                fs::{FileTypeExt, MetadataExt},
                net::UnixDatagram,
            },
        },
        time::{Duration, Instant},
    };
    identity::verify(options.process, options.process, options.binary, unsafe {
        libc::geteuid()
    })?;
    if options.token.len() != 32
        || !options
            .token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(refused());
    }
    if !identity::alive(options.process.pid)? {
        return Ok(StopOutcome::AlreadyAbsent);
    }
    // Register before checking identity so PID reuse cannot swap the watched process afterward.
    let raw = unsafe { libc::kqueue() };
    if raw < 0 {
        return Err(refused());
    }
    let watch = unsafe { OwnedFd::from_raw_fd(raw) };
    if unsafe { libc::fcntl(watch.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(refused());
    }
    let change = libc::kevent {
        ident: options.process.pid as usize,
        filter: libc::EVFILT_PROC,
        flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
        fflags: libc::NOTE_EXIT,
        data: 0,
        udata: std::ptr::null_mut(),
    };
    if unsafe {
        libc::kevent(
            watch.as_raw_fd(),
            &change,
            1,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
        )
    } < 0
    {
        if !identity::alive(options.process.pid)? {
            return Ok(StopOutcome::AlreadyAbsent);
        }
        return Err(refused());
    }
    identity::verify(
        options.process,
        &identity::observe(options.process.pid)?,
        options.binary,
        unsafe { libc::geteuid() },
    )?;
    if !options.control.is_absolute() {
        return Err(refused());
    }
    state::check_private_directory(options.control.parent().ok_or_else(refused)?)?;
    let metadata = || {
        let value = fs::symlink_metadata(options.control).map_err(|_| refused())?;
        if !value.file_type().is_socket()
            || value.uid() != unsafe { libc::geteuid() }
            || value.mode() & 0o077 != 0
            || value.nlink() != 1
        {
            return Err(refused());
        }
        Ok((value.dev(), value.ino()))
    };
    let before = metadata()?;
    let socket = UnixDatagram::unbound().map_err(|_| refused())?;
    socket.set_nonblocking(true).map_err(|_| refused())?;
    socket.connect(options.control).map_err(|_| refused())?;
    if metadata()? != before {
        return Err(refused());
    }
    let message = format!("HKSTOP1{}", options.token);
    if socket.send(message.as_bytes()).map_err(|_| refused())? != message.len() {
        return Err(refused());
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(refused)?;
        let timeout = libc::timespec {
            tv_sec: remaining.as_secs() as libc::time_t,
            tv_nsec: remaining.subsec_nanos() as libc::c_long,
        };
        let mut event = std::mem::MaybeUninit::<libc::kevent>::zeroed();
        let count = unsafe {
            libc::kevent(
                watch.as_raw_fd(),
                std::ptr::null(),
                0,
                event.as_mut_ptr(),
                1,
                &timeout,
            )
        };
        if count < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        if count != 1 {
            return Err(refused());
        }
        let event = unsafe { event.assume_init() };
        if event.ident != change.ident
            || event.filter != libc::EVFILT_PROC
            || event.flags & libc::EV_ERROR != 0
            || event.fflags & libc::NOTE_EXIT == 0
        {
            return Err(refused());
        }
        return Ok(StopOutcome::Exited);
    }
}
#[cfg(not(target_os = "macos"))]
pub fn stop(_options: StopOptions<'_>) -> Result<StopOutcome, CandidateError> {
    Err(refused())
}

#[cfg(all(test, target_os = "macos", feature = "native-stream-relay"))]
mod tests {
    use super::*;
    use crate::provider::identity;
    use std::{
        fs,
        io::{BufRead, BufReader},
        net::{TcpListener, TcpStream},
        os::{
            fd::AsRawFd,
            unix::{fs::PermissionsExt, net::UnixListener},
        },
        path::PathBuf,
        process::{Child, Command, Stdio},
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    struct Fixture {
        child: Child,
        process: ProcessIdentity,
        root: PathBuf,
        control: PathBuf,
        port: u16,
        _upstream: UnixListener,
    }
    impl Fixture {
        fn new() -> Self {
            let root = PathBuf::from(format!(
                "/tmp/hkps-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            let root = root.canonicalize().unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            let path = root.join("upstream");
            let upstream = UnixListener::bind(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            let port = TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port();
            let control = root.join("control");
            let mut child = Command::new(concat!(env!("OUT_DIR"), "/stream-relay-host"))
                .args(["--publish", &port.to_string()])
                .arg(path)
                .args([TOKEN, "10000", "--control"])
                .arg(&control)
                .arg(TOKEN)
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let output = child.stdout.take().unwrap();
            let mut ready = libc::pollfd {
                fd: output.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            if unsafe { libc::poll(&mut ready, 1, 3000) } != 1 {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("publisher startup timed out");
            }
            let mut line = String::new();
            BufReader::new(output).read_line(&mut line).unwrap();
            assert_eq!(line, "ready\n");
            let process = identity::observe(child.id() as i32).unwrap();
            Self {
                child,
                process,
                root,
                control,
                port,
                _upstream: upstream,
            }
        }
        fn options(&self) -> StopOptions<'_> {
            StopOptions {
                process: &self.process,
                binary: &self.process.executable,
                control: &self.control,
                token: TOKEN,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if self.child.try_wait().unwrap().is_none() {
                // Only this unreaped direct test child, never an adopted PID.
                self.child.kill().unwrap();
                self.child.wait().unwrap();
            }
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
    #[test]
    fn native_stop_waits_for_exit_and_repeated_cleanup_proves_absence() {
        let mut fixture = Fixture::new();
        assert_eq!(stop(fixture.options()).unwrap(), StopOutcome::Exited);
        assert!(fixture.child.wait().unwrap().success());
        assert!(TcpStream::connect(("127.0.0.1", fixture.port)).is_err());
        assert!(!fixture.control.exists());
        assert_eq!(stop(fixture.options()).unwrap(), StopOutcome::AlreadyAbsent);
        assert!(fixture.root.join("upstream").exists());
    }
    #[test]
    fn stale_process_or_socket_identity_never_sends_a_stop_request() {
        let mut fixture = Fixture::new();
        for changed in [
            ProcessIdentity {
                start_micros: fixture.process.start_micros + 1,
                ..fixture.process.clone()
            },
            ProcessIdentity {
                uid: fixture.process.uid + 1,
                ..fixture.process.clone()
            },
            ProcessIdentity {
                executable: fixture.root.join("foreign"),
                ..fixture.process.clone()
            },
        ] {
            let mut options = fixture.options();
            options.process = &changed;
            assert!(stop(options).is_err());
            assert!(fixture.child.try_wait().unwrap().is_none());
        }
        let alias = fixture.root.join("alias");
        std::os::unix::fs::symlink(&fixture.control, &alias).unwrap();
        let mut options = fixture.options();
        options.control = &alias;
        assert!(stop(options).is_err());
        assert!(fixture.child.try_wait().unwrap().is_none());
        fs::set_permissions(&fixture.control, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(stop(fixture.options()).is_err());
        assert!(fixture.child.try_wait().unwrap().is_none());
        fs::set_permissions(&fixture.control, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(stop(fixture.options()).unwrap(), StopOutcome::Exited);
        assert!(fixture.child.wait().unwrap().success());
    }
    #[test]
    fn sibling_stop_helper() {
        let Some(receipt) = std::env::var_os("HACK_TEST_PUBLISHER_STOP_RECEIPT") else {
            return;
        };
        let (process, control): (ProcessIdentity, PathBuf) =
            serde_json::from_str(receipt.to_str().unwrap()).unwrap();
        assert_eq!(
            stop(StopOptions {
                process: &process,
                binary: &process.executable,
                control: &control,
                token: TOKEN
            })
            .unwrap(),
            StopOutcome::Exited
        );
    }
    #[test]
    fn stop_observes_publisher_from_a_separate_controller_process() {
        let mut fixture = Fixture::new();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "provider::publisher::tests::sibling_stop_helper",
                "--nocapture",
            ])
            .env(
                "HACK_TEST_PUBLISHER_STOP_RECEIPT",
                serde_json::to_string(&(&fixture.process, &fixture.control)).unwrap(),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
        assert!(fixture.child.wait().unwrap().success());
        assert!(TcpStream::connect(("127.0.0.1", fixture.port)).is_err());
        assert!(!fixture.control.exists());
    }
    #[test]
    fn queued_wrong_token_is_not_shutdown_proof() {
        let mut fixture = Fixture::new();
        let mut options = fixture.options();
        options.token = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        assert_eq!(stop(options).unwrap_err().code, "publisher_stop_uncertain");
        assert!(fixture.child.try_wait().unwrap().is_none());
        assert!(fixture.control.exists());
        assert_eq!(stop(fixture.options()).unwrap(), StopOutcome::Exited);
        assert!(fixture.child.wait().unwrap().success());
    }
}
