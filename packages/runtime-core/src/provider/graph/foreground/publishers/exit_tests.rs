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
struct PublishersGuard(Publishers);
impl Drop for PublishersGuard {
    fn drop(&mut self) {
        for owned in &mut self.0.children {
            if owned.child.try_wait().ok().flatten().is_none() {
                let _ = owned.child.kill();
            }
            let _ = owned.child.wait();
        }
    }
}

/// Production readiness polling with real direct children. Only the checked
/// publication observation is substituted; no Engine/guest readiness is claimed.
#[test]
fn sibling_readiness_survives_pending_and_committed_exits_without_a_false_port_conflict() {
    let root = std::fs::canonicalize("/tmp")
        .unwrap()
        .join(format!("hpub-{}", graph::probes::token().unwrap()));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&root)
        .unwrap();
    let fixture = graph::tests::Fixture(root);
    let candidate = Candidate::discover(&fixture.0).unwrap();
    let lease =
        crate::provider::state::Lock::acquire(&candidate.state_root.join("run/smolvm")).unwrap();
    let first = fixture.0.join("first");
    let second = fixture.0.join("second");
    for root in [&first, &second] {
        std::fs::DirBuilder::new().mode(0o700).create(root).unwrap();
    }
    let (mut dead, dead_port, _first_upstream) = native_publisher(&first);
    let (mut sibling, sibling_port, _second_upstream) = native_publisher(&second);
    let mut guard = PublishersGuard(Publishers {
        owner: "a".repeat(32),
        ..Default::default()
    });
    for (child, port, service, reservation) in [
        (&mut dead, dead_port, "dead", "c".repeat(32)),
        (&mut sibling, sibling_port, "sibling", "d".repeat(32)),
    ] {
        guard.0.children.push(Owned {
            child: child.0.take().unwrap(),
            run: "b".repeat(32),
            reservation,
            service: service.into(),
            hostnames: Vec::new(),
            port: Some(port),
            target: Some(8080),
            exited: None,
            exit_proof: None,
            exit_pending: false,
        });
    }
    guard.0.children[0].child.kill().unwrap();
    await_exit(&guard.0.children[0].child);
    assert_selected_readiness(&candidate, &mut guard.0);
    assert!(guard.0.children[0].exit_pending);
    assert!(guard.0.children[0].exited.is_none());
    // The replacement's own bound listener is not a conflict while it is alive.
    assert!(!guard.0.replacement_port_busy(1).unwrap());
    drop(lease);
    assert_selected_readiness(&candidate, &mut guard.0);
    assert!(guard.0.children[0].exited.is_some());
    assert!(
        !guard
            .0
            .publication_ready_with(&candidate, 1, PublisherReadiness::Replacement, |_, _| Err(
                refused()
            ))
            .unwrap()
    );
    assert!(!guard.0.replacement_port_busy(1).unwrap());

    let lease =
        crate::provider::state::Lock::acquire_existing(&candidate.state_root.join("run/smolvm"))
            .unwrap();
    guard.0.children[1].child.kill().unwrap();
    await_exit(&guard.0.children[1].child);
    assert!(
        guard
            .0
            .publication_ready_with(
                &candidate,
                1,
                PublisherReadiness::Replacement,
                |_, _| panic!("an exited selected child cannot grant readiness")
            )
            .is_err()
    );
    assert!(guard.0.children[1].exit_pending);
    assert!(guard.0.children[1].exited.is_none());
    let _occupied = std::net::TcpListener::bind(("127.0.0.1", sibling_port)).unwrap();
    assert!(!guard.0.replacement_port_busy(1).unwrap());
    drop(lease);
    assert!(
        guard
            .0
            .publication_ready_with(
                &candidate,
                1,
                PublisherReadiness::Replacement,
                |_, _| panic!("the replacement exited")
            )
            .is_err()
    );
    assert!(guard.0.children[1].exited.is_some());
    assert!(guard.0.replacement_port_busy(1).unwrap());
    guard.0.children[1].port = None;
    assert!(!guard.0.replacement_port_busy(1).unwrap());
    assert!(!candidate.state_root.join("run/graphs").exists());
}

fn await_exit(child: &Child) {
    let end = Instant::now() + Duration::from_secs(5);
    while !publication::child_exit_pending(child).unwrap() {
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn assert_selected_readiness(candidate: &Candidate, publishers: &mut Publishers) {
    assert!(
        publishers
            .publication_ready_with(candidate, 1, PublisherReadiness::Replacement, |_, owned| {
                assert_eq!(owned.reservation, "d".repeat(32));
                assert_eq!(owned.service, "sibling");
                Ok(())
            })
            .unwrap()
    );
    assert!(
        publishers
            .publication_ready_with(candidate, 1, PublisherReadiness::Startup, |_, _| panic!(
                "startup still requires every publisher live"
            ))
            .is_err()
    );
}

/// A real native publisher exits, is reaped once and remains observable as down
/// until an explicit stop. No Engine/VM or synthetic publisher stands in for it.
#[test]
fn exited_native_publisher_stays_observable_without_starting_guest_cleanup() {
    exercise(true, false, false);
}

#[test]
fn closed_frontend_notice_stream_does_not_refuse_reaping_before_cleanup() {
    exercise(true, true, false);
}

#[test]
fn startup_publisher_exit_is_reaped_without_a_notice_before_readiness() {
    exercise(false, false, false);
}

#[test]
fn exited_publisher_waits_for_proof_without_blocking_or_claiming_it_live() {
    exercise(true, false, true);
}

fn native_publisher(root: &Path) -> (ChildGuard, u16, UnixListener) {
    let upstream = UnixListener::bind(root.join("upstream")).unwrap();
    std::fs::set_permissions(
        root.join("upstream"),
        std::fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let child = crate::provider::process::publisher_command(Path::new(concat!(
        env!("OUT_DIR"),
        "/stream-relay-host"
    )))
    .args(["--publish", "0"])
    .arg(root.join("upstream"))
    .args(["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "10000", "--control"])
    .arg(root.join("control"))
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
    (guard, port, upstream)
}

fn exercise(announce: bool, broken_notice: bool, busy: bool) {
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
    let (mut guard, port, _upstream) = native_publisher(&fixture.0);
    guard.0.as_mut().unwrap().kill().unwrap();
    let mut publishers = Publishers {
        owner: "a".repeat(32),
        announce: false,
        probe_generations: BTreeMap::new(),
        children: vec![Owned {
            child: guard.0.take().unwrap(),
            run: "b".repeat(32),
            reservation: "c".repeat(32),
            service: "web".into(),
            hostnames: Vec::new(),
            port: Some(port),
            target: Some(8080),
            exited: None,
            exit_proof: None,
            exit_pending: false,
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
    if busy {
        let lease = crate::provider::state::Lock::acquire_existing(
            &candidate.state_root.join("run/smolvm"),
        )
        .unwrap();
        while !publication::child_exit_pending(&publishers.children[0].child).unwrap() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let started = Instant::now();
        assert!(
            publishers
                .reap_exited_with_notice(&candidate, |_, _| panic!("no committed proof, no notice"))
                .unwrap()
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(publishers.has_pending_reap());
        assert!(publishers.children[0].exited.is_none());
        assert!(publishers.children[0].exit_proof.is_none());
        assert!(publication::child_exit_pending(&publishers.children[0].child).unwrap());
        assert!(!publishers.observe_live(&candidate).unwrap());
        assert_eq!(
            publishers.port_status(),
            vec![serde_json::json!({"service":"web","port":port,"target":8080,"state":"down"})]
        );
        drop(lease);
    }
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
        while {
            reap(&mut publishers).unwrap();
            publishers.children[0].exited.is_none()
        } {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(reap(&mut publishers).unwrap());
    }
    assert_eq!(attempted, usize::from(announce));
    assert!(!publishers.has_pending_reap());
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
        vec![serde_json::json!({"service":"web","port":port,"target":8080,"state":"down"})]
    );
    assert!(publishers.children[0].child.try_wait().unwrap().is_some());
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
    assert!(!candidate.state_root.join("run/graphs").exists());
}
