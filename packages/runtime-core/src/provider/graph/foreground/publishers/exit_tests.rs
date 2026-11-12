use super::*;
use std::io::{BufRead, BufReader, Write};
use std::os::{
    fd::AsRawFd,
    unix::{
        fs::{DirBuilderExt, PermissionsExt},
        net::UnixListener,
    },
};
struct ChildGuard(Option<Child>);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}

/// A real native publisher exits, is reaped once and remains observable as down
/// until an explicit stop. No Engine/VM or synthetic publisher stands in for it.
#[test]
fn exited_native_publisher_stays_observable_without_starting_guest_cleanup() {
    exercise(true, false);
}

#[test]
fn closed_frontend_notice_stream_does_not_refuse_reaping_before_cleanup() {
    exercise(true, true);
}

#[test]
fn startup_publisher_exit_is_reaped_without_a_notice_before_readiness() {
    exercise(false, false);
}

fn exercise(announce: bool, broken_notice: bool) {
    let path = std::fs::canonicalize("/tmp")
        .unwrap()
        .join(format!("hpub-{}", graph::probes::token().unwrap()));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&path)
        .unwrap();
    let fixture = graph::tests::Fixture(path);
    let candidate = Candidate::discover(&fixture.0).unwrap();
    drop(crate::provider::state::Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap());
    let _upstream = UnixListener::bind(fixture.0.join("upstream")).unwrap();
    std::fs::set_permissions(
        fixture.0.join("upstream"),
        std::fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let child = crate::provider::process::publisher_command(Path::new(concat!(
        env!("OUT_DIR"),
        "/stream-relay-host"
    )))
    .args(["--publish", "0"])
    .arg(fixture.0.join("upstream"))
    .args(["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "10000", "--control"])
    .arg(fixture.0.join("control"))
    .args(["--control-fd", "0"])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .spawn()
    .unwrap();
    let mut guard = ChildGuard(Some(child));
    let child = guard.0.as_mut().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        .unwrap();
    let mut line = String::new();
    let output = child.stdout.take().unwrap();
    let mut poll = libc::pollfd {
        fd: output.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: one live descriptor and initialized writable poll record.
    assert_eq!(unsafe { libc::poll(&mut poll, 1, 5000) }, 1);
    BufReader::new(output).read_line(&mut line).unwrap();
    let port: u16 = line.trim().strip_prefix("ready ").unwrap().parse().unwrap();
    child.kill().unwrap();
    let mut publishers = Publishers {
        owner: "a".repeat(32),
        announce: false,
        probe_generations: BTreeMap::new(),
        children: vec![Owned {
            child: guard.0.take().unwrap(),
            run: "b".repeat(32),
            reservation: "c".repeat(32),
            hostnames: Vec::new(),
            port: Some(port),
            exited: None,
            exit_proof: None,
        }],
    };
    if announce {
        publishers.announce();
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let (mut notice, reader) = std::os::unix::net::UnixStream::pair().unwrap();
    drop(reader);
    assert_eq!(
        notice.write(b"probe").unwrap_err().kind(),
        std::io::ErrorKind::BrokenPipe
    );
    let mut attempted = 0;
    {
        let mut reap = |publishers: &mut Publishers| {
            publishers.reap_exited_with_notice(&candidate, |run, port| {
                attempted += 1;
                if broken_notice {
                    let error = exit_notice(&mut notice, run, port).unwrap_err();
                    assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
                    Err(error)
                } else {
                    Ok(())
                }
            })
        };
        while !reap(&mut publishers).unwrap() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(reap(&mut publishers).unwrap());
    }
    assert_eq!(attempted, usize::from(announce));
    // Announcing later must not replay a publisher reaped during startup.
    publishers.announce();
    assert!(
        publishers
            .reap_exited_with_notice(&candidate, |_, _| {
                panic!("an already reaped publisher must not announce again")
            })
            .unwrap()
    );
    assert!(!publishers.observe_live(&candidate).unwrap());
    assert_eq!(
        publishers.port_status(),
        vec![serde_json::json!({"port":port,"state":"down"})]
    );
    assert!(publishers.children[0].child.try_wait().unwrap().is_some());
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
    assert!(!candidate.state_root.join("run/graphs").exists());
}
