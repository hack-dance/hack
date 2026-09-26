use super::*;

#[cfg(target_os = "macos")]
use std::{
    io::{Read, Write},
    net::TcpListener,
    os::fd::AsRawFd,
    thread,
    time::Instant,
};

#[cfg(target_os = "macos")]
fn fixture() -> (TcpListener, HostEndpoint) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = HostEndpoint::capture(
        std::process::id() as i32,
        listener.local_addr().unwrap().port(),
    )
    .unwrap();
    (listener, endpoint)
}

#[cfg(target_os = "macos")]
#[test]
fn discovery_requires_the_exact_executable_and_live_exclusive_listener() {
    let (listener, endpoint) = fixture();
    let port = listener.local_addr().unwrap().port();
    let (pid, fingerprint) = HostEndpoint::discover(&endpoint.process.executable, port).unwrap();
    assert_eq!(pid, std::process::id() as i32);
    assert_eq!(fingerprint, endpoint.fingerprint().unwrap());
    assert!(HostEndpoint::discover(Path::new("/bin/sh"), port).is_err());
    assert!(endpoint.require_executable(Path::new("/bin/sh")).is_err());
    drop(listener);
    assert!(HostEndpoint::discover(&endpoint.process.executable, port).is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn executable_pinned_discovery_follows_a_new_listener_process() {
    use std::process::{Child, Command, Stdio};
    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
    let reserved = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reserved.local_addr().unwrap().port();
    drop(reserved);
    let spawn = || {
        OwnedChild(
            Command::new(&executable)
                .args([
                    "--ignored",
                    "--exact",
                    "provider::host_endpoint::tests::discovery_listener_child",
                    "--test-threads=1",
                ])
                .env("HACK_DISCOVERY_LISTENER_PORT", port.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        )
    };
    let await_discovery = |child: &mut OwnedChild| {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(found) = HostEndpoint::discover(&executable, port) {
                assert_eq!(found.0, child.0.id() as i32);
                return found;
            }
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "listener child exited"
            );
            assert!(
                Instant::now() < deadline,
                "listener child was not discovered"
            );
            thread::sleep(Duration::from_millis(10));
        }
    };
    let mut first = spawn();
    let previous = await_discovery(&mut first);
    first.0.kill().unwrap();
    assert!(first.0.wait().unwrap().code().is_none());
    assert!(HostEndpoint::capture(previous.0, port).is_err());
    let mut second = spawn();
    let current = await_discovery(&mut second);
    assert_ne!(previous.0, current.0);
    assert_ne!(previous.1, current.1);
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "owned subprocess fixture for executable_pinned_discovery_follows_a_new_listener_process"]
fn discovery_listener_child() {
    let port: u16 = std::env::var("HACK_DISCOVERY_LISTENER_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let _listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
    thread::sleep(Duration::from_secs(30));
}

#[cfg(target_os = "macos")]
#[test]
fn accepted_stream_preserves_payload_and_half_close() {
    let (listener, endpoint) = fixture();
    listener.set_nonblocking(true).unwrap();
    thread::scope(|scope| {
        let server = scope.spawn(|| {
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut peer = loop {
                match listener.accept() {
                    Ok((peer, _)) => break peer,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "connection was not admitted");
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            peer.set_nonblocking(false).unwrap();
            peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut body = String::new();
            peer.read_to_string(&mut body).unwrap();
            assert_eq!(body, "synthetic endpoint payload");
            peer.write_all(b"reply").unwrap();
        });
        let mut stream = endpoint.connect(Duration::from_secs(2)).unwrap();
        stream.write_all(b"synthetic endpoint payload").unwrap();
        stream.shutdown(std::net::Shutdown::Write).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert_eq!(response, "reply");
        server.join().unwrap();
    });
}

#[cfg(target_os = "macos")]
#[test]
fn pending_accept_times_out_without_releasing_payload() {
    let (listener, endpoint) = fixture();
    let start = Instant::now();
    assert_eq!(
        endpoint
            .connect(Duration::from_millis(80))
            .unwrap_err()
            .code,
        "host_endpoint_timeout"
    );
    assert!(start.elapsed() < Duration::from_secs(2));
    listener.set_nonblocking(true).unwrap();
    let (mut stream, _) = listener.accept().unwrap();
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut data = Vec::new();
    stream.read_to_end(&mut data).unwrap();
    assert!(data.is_empty());
}

#[cfg(target_os = "macos")]
#[test]
fn replacement_listener_is_refused_in_the_same_process() {
    isolated_replacement("provider::host_endpoint::tests::replacement_listener_child");
}
#[cfg(target_os = "macos")]
#[test]
#[ignore = "isolated close/rebind fixture launched by replacement_listener_is_refused_in_the_same_process"]
fn replacement_listener_child() {
    let (listener, endpoint) = fixture();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let replacement = TcpListener::bind(address).unwrap();
    let current = HostEndpoint::capture(std::process::id() as i32, address.port()).unwrap();
    assert_ne!(current.listener.generation, endpoint.listener.generation);
    assert!(endpoint.connect(Duration::from_millis(80)).is_err());
    replacement.set_nonblocking(true).unwrap();
    assert_eq!(
        replacement.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[cfg(target_os = "macos")]
#[test]
fn changed_generation_or_process_cannot_authorize_connection() {
    let (_listener, endpoint) = fixture();
    let mut changed = endpoint.clone();
    changed.listener.generation += 1;
    assert!(changed.connect(Duration::from_millis(80)).is_err());
    let mut changed = endpoint.clone();
    changed.process.start_micros += 1;
    assert!(changed.connect(Duration::from_millis(80)).is_err());
    assert!(endpoint.connect(Duration::ZERO).is_err());
    assert!(endpoint.connect(Duration::from_secs(6)).is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn shared_or_wildcard_listener_is_not_captured() {
    let (listener, endpoint) = fixture();
    let enabled: libc::c_int = 1;
    // SAFETY: the live listener owns fd; enabled points to a correctly sized integer.
    assert_eq!(
        unsafe {
            libc::setsockopt(
                listener.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_REUSEPORT,
                (&enabled as *const libc::c_int).cast(),
                std::mem::size_of_val(&enabled) as libc::socklen_t,
            )
        },
        0
    );
    assert!(HostEndpoint::capture(std::process::id() as i32, endpoint.port).is_err());
    let wildcard = TcpListener::bind("0.0.0.0:0").unwrap();
    assert!(
        HostEndpoint::capture(
            std::process::id() as i32,
            wildcard.local_addr().unwrap().port()
        )
        .is_err()
    );
}

#[cfg(not(target_os = "macos"))]
#[test]
fn unsupported_host_refuses_identity_capture() {
    assert_eq!(
        HostEndpoint::capture(123, 1234).unwrap_err().code,
        "unsupported_host"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn replacement_between_precheck_and_connect_receives_no_payload() {
    let (listener, endpoint) = fixture();
    let address = listener.local_addr().unwrap();
    let mut replacement = None;
    let result = endpoint.connect_after_check(Duration::from_secs(1), || {
        drop(listener);
        // Parallel subprocess creation can briefly retain a forked copy of the
        // closed listener until exec. Require a real replacement before connect;
        // a collision or timeout must never count as the expected identity refusal.
        let deadline = Instant::now() + Duration::from_millis(250);
        replacement = Some(loop {
            match TcpListener::bind(address) {
                Ok(listener) => break listener,
                Err(error)
                    if error.kind() == std::io::ErrorKind::AddrInUse
                        && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("Replacement listener could not bind: {error}"),
            }
        });
    });
    assert_eq!(result.unwrap_err().code, "host_endpoint_identity");
    let replacement = replacement.unwrap();
    replacement.set_nonblocking(true).unwrap();
    let (mut peer, _) = replacement.accept().unwrap();
    peer.set_nonblocking(false).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    let mut data = Vec::new();
    peer.read_to_end(&mut data).unwrap();
    assert!(data.is_empty());
}

#[cfg(target_os = "macos")]
fn accept_pending(listener: &TcpListener) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match listener.accept() {
            Ok((stream, _)) => return stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline, "pending connect never arrived");
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => panic!("accept failed: {error}"),
        }
    }
}

#[cfg(target_os = "macos")]
fn authorization() -> (super::super::relay_auth::Authority, AuthorizedSession) {
    use super::super::relay_auth::{Authority, Binding, Credential};
    let credential = Credential::from_private_input(
        Binding {
            owner: [1; 16],
            boot: [2; 16],
            endpoint: [3; 32],
            service: [4; 32],
        },
        [7; 32],
    )
    .unwrap();
    let authority = Authority::new(&credential);
    let (client, hello) = credential.begin().unwrap();
    let (server, response) = authority.challenge(&hello).unwrap();
    let (client, proof) = client.answer(&response).unwrap();
    let (session, accepted) = server.finish(&proof).unwrap();
    client.accept(&accepted).unwrap();
    (authority, session)
}

#[cfg(target_os = "macos")]
#[test]
fn pending_connection_releases_only_after_accept_and_is_nonblocking() {
    let (listener, endpoint) = fixture();
    let (_authority, session) = authorization();
    let mut pending = endpoint
        .begin_connect(Duration::from_secs(2), &session)
        .unwrap();
    assert!(pending.progress().unwrap().is_none());
    listener.set_nonblocking(true).unwrap();
    let mut peer = accept_pending(&listener);
    let mut stream = pending.progress().unwrap().unwrap();
    assert!(pending.progress().is_err());
    assert_eq!(
        stream.read(&mut [0]).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    session
        .with_active(|| stream.write_all(b"verified"))
        .unwrap()
        .unwrap();
    peer.set_nonblocking(false).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    let mut data = [0; 8];
    peer.read_exact(&mut data).unwrap();
    assert_eq!(&data, b"verified");
}

#[cfg(target_os = "macos")]
#[test]
fn revoked_connection_never_starts_and_pending_revoke_closes_without_data() {
    let (listener, endpoint) = fixture();
    listener.set_nonblocking(true).unwrap();
    let (authority, session) = authorization();
    authority.revoke();
    assert!(
        endpoint
            .begin_connect(Duration::from_secs(1), &session)
            .is_err()
    );
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    let (authority, session) = authorization();
    let mut pending = endpoint
        .begin_connect(Duration::from_secs(1), &session)
        .unwrap();
    let mut peer = accept_pending(&listener);
    authority.revoke();
    assert_eq!(pending.progress().err().unwrap().code, "relay_auth_refused");
    assert!(pending.stream.is_none());
    peer.set_nonblocking(false).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    assert_eq!(peer.read(&mut [0]).unwrap(), 0);
}

#[cfg(target_os = "macos")]
#[test]
fn pending_timeout_and_drop_release_the_socket_without_data() {
    let (listener, endpoint) = fixture();
    listener.set_nonblocking(true).unwrap();
    let (_authority, session) = authorization();
    for expire in [true, false] {
        let mut pending = endpoint
            .begin_connect(Duration::from_secs(1), &session)
            .unwrap();
        let mut peer = accept_pending(&listener);
        if expire {
            pending.deadline = Instant::now();
            assert_eq!(
                pending.progress().err().unwrap().code,
                "host_endpoint_timeout"
            );
            assert!(pending.stream.is_none());
        }
        drop(pending);
        peer.set_nonblocking(false).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        assert_eq!(peer.read(&mut [0]).unwrap(), 0);
    }
    assert!(endpoint.begin_connect(Duration::ZERO, &session).is_err());
    assert!(
        endpoint
            .begin_connect(Duration::from_secs(6), &session)
            .is_err()
    );
}

#[cfg(target_os = "macos")]
#[test]
fn pending_replacement_cannot_release_stream() {
    isolated_replacement("provider::host_endpoint::tests::pending_replacement_child");
}
#[cfg(target_os = "macos")]
fn isolated_replacement(test: &str) {
    // The close/rebind fixture must not be inherited by unrelated parallel forks.
    // Keep its sockets in an isolated child and require the complete assertion path.
    use std::process::{Child, Command, Stdio};
    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", test])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "endpoint replacement child exceeded its watchdog"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    let mut output = String::new();
    child
        .0
        .stdout
        .take()
        .unwrap()
        .take(4097)
        .read_to_string(&mut output)
        .unwrap();
    assert!(output.len() <= 4096);
    assert!(
        output.contains("test result: ok. 1 passed"),
        "isolated assertion did not run"
    );
}
#[cfg(target_os = "macos")]
#[test]
#[ignore = "isolated close/rebind fixture launched by pending_replacement_cannot_release_stream"]
fn pending_replacement_child() {
    let (listener, endpoint) = fixture();
    let (_authority, session) = authorization();
    let address = listener.local_addr().unwrap();
    let mut pending = endpoint
        .begin_connect(Duration::from_secs(1), &session)
        .unwrap();
    drop(listener);
    let replacement = TcpListener::bind(address).unwrap();
    assert!(pending.progress().is_err());
    assert!(pending.stream.is_none());
    replacement.set_nonblocking(true).unwrap();
    assert_eq!(
        replacement.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[cfg(target_os = "macos")]
#[test]
fn pending_socket_survives_closed_peer_with_default_sigpipe() {
    const HELPER: &str = "HACK_TEST_PENDING_SIGPIPE";
    if std::env::var_os(HELPER).is_none() {
        use std::os::unix::process::ExitStatusExt;
        // Signal disposition changes only in these exact owned child processes.
        for mode in ["unprotected", "protected"] {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "provider::host_endpoint::tests::pending_socket_survives_closed_peer_with_default_sigpipe", "--test-threads=1"])
                .env_clear().env(HELPER,mode)
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).spawn().unwrap();
            let deadline = Instant::now() + Duration::from_secs(6);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    if mode == "unprotected" {
                        assert_eq!(status.signal(), Some(libc::SIGPIPE));
                    } else {
                        assert!(
                            status.success(),
                            "closed peer killed the protected child: {status}"
                        );
                    }
                    break;
                }
                if Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("SIGPIPE fixture exceeded budget");
                }
                thread::sleep(Duration::from_millis(5));
            }
        }
        return;
    }
    let (listener, endpoint) = fixture();
    listener.set_nonblocking(true).unwrap();
    let (_authority, session) = authorization();
    let mut pending = endpoint
        .begin_connect(Duration::from_secs(2), &session)
        .unwrap();
    let peer = accept_pending(&listener);
    let stream = pending.progress().unwrap().unwrap();
    if std::env::var(HELPER).unwrap() == "unprotected" {
        let disabled: libc::c_int = 0;
        // SAFETY: this isolated negative-control child owns the descriptor; the
        // option buffer is a readable native int of the supplied size.
        assert_eq!(
            unsafe {
                libc::setsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_NOSIGPIPE,
                    (&disabled as *const libc::c_int).cast(),
                    std::mem::size_of_val(&disabled) as libc::socklen_t,
                )
            },
            0
        );
    }
    let linger = libc::linger {
        l_onoff: 1,
        l_linger: 0,
    };
    // SAFETY: peer owns its descriptor and linger has the native option layout.
    assert_eq!(
        unsafe {
            libc::setsockopt(
                peer.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_LINGER,
                (&linger as *const libc::linger).cast(),
                std::mem::size_of_val(&linger) as libc::socklen_t,
            )
        },
        0
    );
    drop(peer);
    // SAFETY: process-local signal disposition is changed only in the child above.
    assert_ne!(
        unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) },
        libc::SIG_ERR
    );
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let byte = [42_u8];
        // SAFETY: live stream descriptor and readable one-byte buffer. A raw write
        // ensures the socket option, not a send flag or Rust's default SIG_IGN,
        // protects this process against SIGPIPE.
        let written = unsafe { libc::write(stream.as_raw_fd(), byte.as_ptr().cast(), 1) };
        if written < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EPIPE) {
            break;
        }
        assert!(Instant::now() < deadline, "peer did not reach EPIPE");
        thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(target_os = "macos")]
#[test]
fn revocation_readiness_wakes_handler_and_closes_pending_socket() {
    use std::os::fd::AsFd;
    let (listener, endpoint) = fixture();
    listener.set_nonblocking(true).unwrap();
    let (authority, session) = authorization();
    let watch = session.watch_revocation().unwrap();
    let pending = endpoint
        .begin_connect(Duration::from_secs(2), &session)
        .unwrap();
    let mut peer = accept_pending(&listener);
    thread::scope(|scope| {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let handler = scope.spawn(move || {
            let mut fd = libc::pollfd {
                fd: watch.as_fd().as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            ready_tx.send(()).unwrap();
            // SAFETY: a live owned watch keeps its initialized pollfd valid through
            // this bounded call; the kernel does not retain the pointer.
            assert_eq!(unsafe { libc::poll(&mut fd, 1, 2000) }, 1);
            assert!(watch.is_revoked().unwrap());
            drop(pending);
        });
        ready_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        authority.revoke();
        handler.join().unwrap();
    });
    peer.set_nonblocking(false).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    assert_eq!(peer.read(&mut [0]).unwrap(), 0);
    assert!(session.with_active(|| ()).is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn pending_accept_after_backend_fin_preserves_request_direction() {
    let (listener, endpoint) = fixture();
    let (_authority, session) = authorization();
    let mut pending = endpoint
        .begin_connect(Duration::from_secs(2), &session)
        .unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut peer = accept_pending(&listener);
    peer.set_nonblocking(false).unwrap();
    peer.shutdown(std::net::Shutdown::Write).unwrap();
    // Observe FIN before identity inspection, without releasing caller payload.
    let raw = pending.stream.as_mut().unwrap();
    raw.set_nonblocking(false).unwrap();
    raw.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    assert_eq!(raw.read(&mut [0]).unwrap(), 0);
    raw.set_nonblocking(true).unwrap();
    let mut stream = pending
        .progress()
        .unwrap()
        .expect("accepted half-closed peer must be identified");
    session
        .with_active(|| stream.write_all(b"request"))
        .unwrap()
        .unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    let mut received = [0; 7];
    peer.read_exact(&mut received).unwrap();
    assert_eq!(&received, b"request");
}

#[cfg(target_os = "macos")]
#[test]
fn backend_fin_does_not_bypass_listener_replacement() {
    let (listener, endpoint) = fixture();
    let (_authority, session) = authorization();
    let mut pending = endpoint
        .begin_connect(Duration::from_secs(2), &session)
        .unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut peer = accept_pending(&listener);
    peer.set_nonblocking(false).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    peer.shutdown(std::net::Shutdown::Write).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    // Parallel subprocess fixtures can briefly inherit the closing listener
    // during fork/exec. Require a real replacement within a bounded window.
    let deadline = Instant::now() + Duration::from_millis(500);
    let _replacement = loop {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => break listener,
            Err(error)
                if error.kind() == std::io::ErrorKind::AddrInUse && Instant::now() < deadline =>
            {
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => panic!("Replacement listener could not bind: {error}"),
        }
    };
    assert!(pending.progress().is_err());
    assert!(pending.stream.is_none());
    assert_eq!(peer.read(&mut [0]).unwrap(), 0);
}

#[cfg(target_os = "macos")]
#[test]
fn closed_accepted_descriptor_cannot_prove_peer_identity() {
    let (listener, endpoint) = fixture();
    let (_authority, session) = authorization();
    let mut pending = endpoint
        .begin_connect(Duration::from_secs(2), &session)
        .unwrap();
    listener.set_nonblocking(true).unwrap();
    let peer = accept_pending(&listener);
    drop(peer);
    assert!(pending.progress().unwrap().is_none());
    pending.deadline = Instant::now();
    assert_eq!(
        pending.progress().unwrap_err().code,
        "host_endpoint_timeout"
    );
}
