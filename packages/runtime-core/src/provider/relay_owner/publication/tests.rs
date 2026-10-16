use super::*;
use crate::provider::{host_endpoint::HostEndpoint, relay_loop::Limits, relay_owner::OwnerLimits};
use std::{
    net::TcpListener,
    os::unix::net::UnixStream,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
fn context() -> Context {
    Context {
        runtime: [1; 16],
        boot: [2; 16],
    }
}
fn owner() -> RelayOwner {
    RelayOwner::new(
        context(),
        OwnerLimits {
            registrations: 2,
            controls: 2,
            relay: Limits {
                max_flows: 2,
                connect_timeout: Duration::from_secs(1),
                idle_timeout: Duration::from_secs(2),
            },
        },
    )
    .unwrap()
}
struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = fs::canonicalize("/tmp").unwrap().join(format!(
            "hrpub-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn paths(root: &Root) -> Paths {
    Paths::new(&root.0).unwrap()
}
fn request(owner: &mut RelayOwner) -> (TcpListener, RetireRequest) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = HostEndpoint::capture(
        std::process::id() as i32,
        listener.local_addr().unwrap().port(),
    )
    .unwrap();
    let grant = owner.register([3; 32], endpoint).unwrap();
    let request = RetireRequest {
        version: 1,
        owner: owner.incarnation(),
        operation: [4; 16],
        targets: vec![grant.target],
    };
    (listener, request)
}
#[test]
fn private_named_endpoint_retires_and_cleans_only_owned_publication() {
    let root = Root::new();
    let mut owner = owner();
    let (_backend, request) = request(&mut owner);
    let listener = ControlListener::bind(&root.0, &mut owner).unwrap();
    let pin = PinnedEndpoint::load(&root.0, context()).unwrap();
    assert_eq!(pin.fingerprint(), listener.endpoint().fingerprint());
    let (relay, mut guest) = UnixStream::pair().unwrap();
    guest
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    owner
        .admit(&request.targets[0], relay, Duration::from_secs(1))
        .unwrap();
    let mut client = pin.connect(request, Duration::from_secs(1)).unwrap();
    assert!(listener.accept(&mut owner, Duration::from_secs(1)).unwrap());
    let mut ack = None;
    for _ in 0..100 {
        owner.tick(Duration::ZERO).unwrap();
        ack = client.progress().unwrap();
        if ack.is_some() {
            break;
        }
    }
    assert!(ack.is_some());
    assert_eq!(guest.read(&mut [0]).unwrap(), 0);
    assert!(pin.recover().is_err());
    drop(listener);
    assert!(absent(&paths(&root).socket).unwrap());
    assert!(absent(&paths(&root).receipt).unwrap());
    assert!(paths(&root).directory.join("operation.lock").is_file());
    pin.recover().unwrap();
}
#[test]
fn stale_scope_receipt_and_socket_replacements_refuse_before_control_bytes() {
    let root = Root::new();
    let mut owner = owner();
    let (_backend, request) = request(&mut owner);
    let listener = ControlListener::bind(&root.0, &mut owner).unwrap();
    let pin = listener.endpoint();
    let mut wrong = context();
    wrong.boot[0] ^= 1;
    assert!(PinnedEndpoint::load(&root.0, wrong).is_err());
    let mut stale = request.clone();
    stale.owner[0] ^= 1;
    assert!(pin.connect(stale, Duration::from_secs(1)).is_err());
    fs::remove_file(&pin.paths.socket).unwrap();
    let replacement = UnixListener::bind(&pin.paths.socket).unwrap();
    fs::set_permissions(&pin.paths.socket, fs::Permissions::from_mode(0o600)).unwrap();
    replacement.set_nonblocking(true).unwrap();
    assert!(pin.connect(request, Duration::from_secs(1)).is_err());
    assert_eq!(
        replacement.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    drop(listener);
    assert!(pin.paths.receipt.exists());
    assert!(pin.paths.socket.exists());
}
#[test]
fn identical_receipt_replacement_and_parent_rebinding_are_preserved() {
    for replace_parent in [false, true] {
        let root = Root::new();
        let mut owner = owner();
        let listener = ControlListener::bind(&root.0, &mut owner).unwrap();
        let pin = listener.endpoint();
        if replace_parent {
            fs::rename(&pin.paths.directory, root.0.join("preserved")).unwrap();
            fs::create_dir(&pin.paths.directory).unwrap();
            fs::set_permissions(&pin.paths.directory, fs::Permissions::from_mode(0o700)).unwrap();
            fs::write(&pin.paths.receipt, b"replacement").unwrap();
        } else {
            let replacement = pin.paths.directory.join("replacement.json");
            fs::write(&replacement, &pin.bytes).unwrap();
            fs::set_permissions(&replacement, fs::Permissions::from_mode(0o600)).unwrap();
            fs::rename(replacement, &pin.paths.receipt).unwrap();
        }
        assert!(pin.verify_receipt().is_err());
        drop(listener);
        assert!(pin.paths.receipt.exists());
        if replace_parent {
            assert!(root.0.join("preserved/control.sock").exists());
        } else {
            assert!(pin.paths.socket.exists());
        }
    }
}
#[test]
fn partial_or_unsafe_publication_is_not_adopted_or_deleted() {
    let root = Root::new();
    let mut owner = owner();
    let p = paths(&root);
    state::private_directory(&p.directory).unwrap();
    fs::write(&p.socket, b"foreign").unwrap();
    assert!(ControlListener::bind(&root.0, &mut owner).is_err());
    assert_eq!(fs::read(&p.socket).unwrap(), b"foreign");
    assert!(PinnedEndpoint::load(&root.0, context()).is_err());
    fs::remove_file(&p.socket).unwrap();
    fs::write(&p.receipt, b"partial").unwrap();
    fs::set_permissions(&p.receipt, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(ControlListener::bind(&root.0, &mut owner).is_err());
    assert!(PinnedEndpoint::load(&root.0, context()).is_err());
    assert_eq!(fs::read(&p.receipt).unwrap(), b"partial");
}
#[test]
fn permissive_hardlinked_or_symlinked_receipts_refuse() {
    for mode in 0..3 {
        let root = Root::new();
        let mut owner = owner();
        let listener = ControlListener::bind(&root.0, &mut owner).unwrap();
        let p = paths(&root);
        match mode {
            0 => fs::set_permissions(&p.receipt, fs::Permissions::from_mode(0o644)).unwrap(),
            1 => fs::hard_link(&p.receipt, root.0.join("linked")).unwrap(),
            _ => {
                fs::rename(&p.receipt, root.0.join("original")).unwrap();
                std::os::unix::fs::symlink(root.0.join("original"), &p.receipt).unwrap();
            }
        }
        assert!(PinnedEndpoint::load(&root.0, context()).is_err());
        drop(listener);
        assert!(fs::symlink_metadata(&p.receipt).is_ok());
        assert!(p.socket.exists());
    }
}

#[test]
fn full_listener_backlog_refuses_without_blocking_connect() {
    let root = Root::new();
    let mut child = spawn_child(&root, true);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "connect exceeded the child watchdog"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(
        fs::read(root.0.join("backlog-checked")).unwrap(),
        b"refused"
    );
}
fn backlog_probe(listener: &ControlListener) {
    use std::os::fd::AsRawFd;
    // SAFETY: listener owns this live listening socket; listen changes only its backlog.
    assert_eq!(unsafe { libc::listen(listener.as_fd().as_raw_fd(), 1) }, 0);
    let mut clients = Vec::new();
    let mut refused = false;
    for _ in 0..8 {
        match connect::immediate(&listener.endpoint.paths.socket) {
            Ok(stream) => clients.push(stream),
            Err(_) => {
                refused = true;
                break;
            }
        }
    }
    assert!(refused);
    assert!(!clients.is_empty());
}
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[test]
#[ignore = "private subprocess fixture for publication recovery and backlog tests"]
fn publication_child() {
    let root = PathBuf::from(
        std::env::var_os("HACK_RELAY_TEST_PUBLICATION_ROOT").expect("explicit child root"),
    );
    let mut owner = owner();
    let listener = ControlListener::bind(&root, &mut owner).unwrap();
    if std::env::var("HACK_RELAY_TEST_BACKLOG").as_deref() == Ok("1") {
        backlog_probe(&listener);
        fs::write(root.join("backlog-checked"), b"refused").unwrap();
        return;
    }
    let mut byte = [0];
    std::io::stdin().read_exact(&mut byte).unwrap();
}
fn spawn_child(root: &Root, backlog: bool) -> OwnedChild {
    OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "provider::relay_owner::publication::tests::publication_child",
            ])
            .env("HACK_RELAY_TEST_PUBLICATION_ROOT", &root.0)
            .env("HACK_RELAY_TEST_BACKLOG", if backlog { "1" } else { "0" })
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}
#[test]
fn dead_publication_recovery_requires_unchanged_receipt_and_socket() {
    for replace_socket in [false, true] {
        let root = Root::new();
        let mut child = spawn_child(&root, false);
        let deadline = Instant::now() + Duration::from_secs(3);
        let pin = loop {
            if let Ok(pin) = PinnedEndpoint::load(&root.0, context()) {
                break pin;
            }
            assert!(Instant::now() < deadline);
            assert!(child.0.try_wait().unwrap().is_none());
            std::thread::sleep(Duration::from_millis(1));
        };
        assert_eq!(pin.receipt.process.pid, child.0.id() as i32);
        assert!(pin.recover().is_err());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let mut replacement = None;
        if replace_socket {
            fs::remove_file(&pin.paths.socket).unwrap();
            replacement = Some(UnixListener::bind(&pin.paths.socket).unwrap());
            fs::set_permissions(&pin.paths.socket, fs::Permissions::from_mode(0o600)).unwrap();
        }
        if replace_socket {
            assert!(pin.recover().is_err());
            assert!(pin.paths.socket.exists());
            assert!(pin.paths.receipt.exists());
        } else {
            pin.recover().unwrap();
            pin.recover().unwrap();
            assert!(absent(&pin.paths.socket).unwrap());
            assert!(absent(&pin.paths.receipt).unwrap());
        }
        drop(replacement);
    }
}

#[test]
fn named_selection_verifies_an_explicit_empty_graph_without_retirement() {
    let root = Root::new();
    let mut owner = owner();
    let listener = ControlListener::bind(&root.0, &mut owner).unwrap();
    let request = SelectionRequest::new(
        owner.incarnation(),
        [6; 16],
        super::super::GraphScope::new(context(), [7; 32]).unwrap(),
    )
    .unwrap();
    let mut client = listener
        .endpoint()
        .select(request, Duration::from_secs(1))
        .unwrap();
    assert!(listener.accept(&mut owner, Duration::from_secs(1)).unwrap());
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        owner.tick(Duration::ZERO).unwrap();
        if let Some(value) = client.progress().unwrap() {
            assert!(value.targets().is_empty());
            break;
        }
        assert!(Instant::now() < deadline);
    }
    assert_eq!(owner.connections(), 0);
}
