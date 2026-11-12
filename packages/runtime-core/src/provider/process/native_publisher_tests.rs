//! Real native publisher through the production spawn factory, on both hosts.
use super::*;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    os::{
        fd::AsRawFd,
        unix::{
            fs::{DirBuilderExt, PermissionsExt},
            net::UnixListener,
        },
    },
    process::Stdio,
};

pub(crate) struct NativePublisher {
    pub(crate) child: std::process::Child,
    pub(crate) port: u16,
    root: std::path::PathBuf,
    _upstream: UnixListener,
    #[cfg(target_os = "macos")]
    identity: Option<crate::provider::identity::ProcessIdentity>,
}
impl NativePublisher {
    pub(crate) fn new(root: std::path::PathBuf) -> Self {
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let upstream = UnixListener::bind(root.join("upstream")).unwrap();
        fs::set_permissions(root.join("upstream"), fs::Permissions::from_mode(0o700)).unwrap();
        let child = publisher_command(std::path::Path::new(concat!(
            env!("OUT_DIR"),
            "/stream-relay-host"
        )))
        .env_clear()
        .args(["--publish", "0"])
        .arg(root.join("upstream"))
        .args(["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "10000", "--control"])
        .arg(root.join("control"))
        .args(["--control-fd", "0"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
        let mut value = Self {
            child,
            port: 0,
            root,
            _upstream: upstream,
            #[cfg(target_os = "macos")]
            identity: None,
        };
        value
            .child
            .stdin
            .take()
            .unwrap()
            .write_all(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .unwrap();
        let output = value.child.stdout.take().unwrap();
        let mut ready = libc::pollfd {
            fd: output.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one initialized entry; output retains its descriptor.
        assert_eq!(unsafe { libc::poll(&mut ready, 1, 3000) }, 1);
        let mut line = String::new();
        BufReader::new(output).read_line(&mut line).unwrap();
        value.port = line.trim().strip_prefix("ready ").unwrap().parse().unwrap();
        #[cfg(target_os = "macos")]
        {
            value.identity =
                Some(crate::provider::identity::observe(value.child.id() as i32).unwrap());
        }
        value
    }
    pub(crate) fn stop(&mut self) {
        #[cfg(target_os = "macos")]
        {
            let identity = self.identity.as_ref().unwrap();
            crate::provider::publisher::stop(crate::provider::publisher::StopOptions {
                process: identity,
                binary: &identity.executable,
                control: &self.root.join("control"),
                token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            })
            .unwrap();
        }
        #[cfg(not(target_os = "macos"))]
        std::os::unix::net::UnixDatagram::unbound()
            .unwrap()
            .send_to(
                b"HKSTOP1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                self.root.join("control"),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(TcpStream::connect(("127.0.0.1", self.port)).is_err());
    }
}
#[cfg(target_os = "macos")]
impl NativePublisher {
    pub(crate) fn confirm_crash(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if self.child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let identity = self.identity.as_ref().unwrap();
        assert_eq!(
            crate::provider::publisher::stop_with_exit(
                crate::provider::publisher::StopOptions {
                    process: identity,
                    binary: &identity.executable,
                    control: &self.root.join("control"),
                    token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                },
                Some(identity)
            )
            .unwrap(),
            crate::provider::publisher::StopOutcome::AlreadyAbsent
        );
        assert!(TcpStream::connect(("127.0.0.1", self.port)).is_err());
    }
}
impl Drop for NativePublisher {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn real_publisher_survives_group_interrupt_until_authenticated_stop() {
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "provider::process::native_publisher_tests::real_publisher_probe",
            "--nocapture",
        ])
        .env("HACK_NATIVE_PUBLISHER_PROBE", "1")
        .process_group(0)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("native-publisher-cleaned"));
}

#[test]
fn real_publisher_probe() {
    if std::env::var_os("HACK_NATIVE_PUBLISHER_PROBE").is_none() {
        return;
    }
    extern "C" fn caught(_: libc::c_int) {}
    // SAFETY: isolated owned helper; handler only returns. Exec resets it.
    unsafe {
        libc::signal(libc::SIGINT, caught as *const () as libc::sighandler_t);
    }
    // Native stop rejects aliased ancestors; Unix sockets also need a short path.
    let root = fs::canonicalize("/tmp")
        .unwrap()
        .join(format!("native-pub-{}", std::process::id()));
    let mut child = NativePublisher::new(root);
    // SAFETY: retained direct child prevents PID reuse before reaping.
    assert_eq!(
        unsafe { libc::getpgid(child.child.id() as i32) },
        child.child.id() as i32
    );
    // SAFETY: signal only this test helper's own dedicated group.
    assert_eq!(
        unsafe { libc::kill(-(std::process::id() as i32), libc::SIGINT) },
        0
    );
    assert!(child.child.try_wait().unwrap().is_none());
    assert!(TcpStream::connect(("127.0.0.1", child.port)).is_ok());
    child.stop();
    println!("native-publisher-cleaned");
}
