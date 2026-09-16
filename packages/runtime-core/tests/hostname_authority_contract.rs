#![cfg(target_os = "macos")]
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{MetadataExt, PermissionsExt},
            net::UnixStream,
        },
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Authority {
    child: Child,
    root: PathBuf,
    socket: PathBuf,
}
fn command(socket: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hack-runtime-candidate"));
    command
        .arg("--candidate-root")
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .canonicalize()
                .unwrap(),
        )
        .args(["runtime", "serve-hostnames", "--socket"])
        .arg(socket)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}
impl Authority {
    fn start() -> Self {
        let root = PathBuf::from(format!(
            "/private/tmp/hka-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = root.join("authority");
        let mut child = command(&socket).spawn().unwrap();
        let output = child.stdout.take().unwrap();
        let mut fd = libc::pollfd {
            fd: output.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        assert_eq!(unsafe { libc::poll(&mut fd, 1, 3000) }, 1);
        let mut line = String::new();
        BufReader::new(output).read_line(&mut line).unwrap();
        assert_eq!(line, "ready\n");
        Self {
            child,
            root,
            socket,
        }
    }
    fn connect(&self) -> UnixStream {
        let stream = UnixStream::connect(&self.socket).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream
    }
    fn stop(&mut self) {
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(exit) = self.child.try_wait().unwrap() {
                assert!(exit.success());
                break;
            }
            if Instant::now() > deadline {
                self.child.kill().unwrap();
                self.child.wait().unwrap();
                panic!("authority ignored owner EOF");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Authority {
    fn drop(&mut self) {
        self.stop();
        fs::remove_dir_all(&self.root).unwrap();
    }
}
#[test]
fn owner_eof_bounds_slow_clients_and_preserves_foreign_paths() {
    let mut a = Authority::start();
    assert_eq!(fs::metadata(&a.socket).unwrap().mode() & 0o777, 0o600);
    let inode = fs::metadata(&a.socket).unwrap().ino();
    let conflict = command(&a.socket)
        .spawn()
        .unwrap()
        .wait_with_output()
        .unwrap();
    assert!(!conflict.status.success());
    assert_eq!(fs::metadata(&a.socket).unwrap().ino(), inode);
    let mut slow = a.connect();
    slow.write_all(b"GET /route").unwrap();
    let mut client = a.connect();
    client
        .write_all(b"GET /ask?domain=a HTTP/1.1\r\nHost: local\r\n\r\n")
        .unwrap();
    let mut reply = String::new();
    client.read_to_string(&mut reply).unwrap();
    assert!(reply.starts_with("HTTP/1.1 400"));
    let mut end = [0; 1];
    assert_eq!(slow.read(&mut end).unwrap(), 0);
    let mut oversized = a.connect();
    let _ = oversized.write_all(&vec![b'x'; 8192]);
    match oversized.read(&mut end) {
        Ok(n) => assert_eq!(n, 0),
        Err(e) => assert_eq!(e.kind(), std::io::ErrorKind::ConnectionReset),
    }
    a.stop();
    assert!(!a.socket.exists());
    let mut b = Authority::start();
    fs::remove_file(&b.socket).unwrap();
    fs::write(&b.socket, b"foreign").unwrap();
    b.stop();
    assert_eq!(fs::read(&b.socket).unwrap(), b"foreign");
}
