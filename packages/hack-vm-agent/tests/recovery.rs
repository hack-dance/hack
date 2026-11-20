//! Walk Connect, Lose, HostRestart, Start, Exit, Inspect and GuestRestart
//! against an actual agent. Restarting only the agent also invalidates handles.
use hack_vm_protocol::{
    Handle, Request, Response, Stream,
    client::{GuestClient, Session},
    write_frame,
};
use std::{
    fs,
    io::Write,
    os::unix::net::UnixStream,
    path::PathBuf,
    process::{Child, Command},
    thread,
    time::{Duration, Instant},
};

struct Fixture {
    dir: PathBuf,
    child: Child,
}
impl Fixture {
    fn boot(dir: PathBuf) -> Self {
        let child = Command::new(env!("CARGO_BIN_EXE_hack-vm-agent"))
            .env_clear()
            .env("HOME", &dir)
            .arg(dir.join("agent.sock"))
            .spawn()
            .unwrap();
        Self { dir, child }
    }
    fn connect(&self) -> UnixStream {
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(s) = UnixStream::connect(self.dir.join("agent.sock")) {
                return s;
            }
            assert!(Instant::now() < end);
            thread::sleep(Duration::from_millis(5));
        }
    }
    fn request(&self, r: Request) -> Response {
        let s = self.connect();
        Session::negotiate(&s, Duration::from_secs(2))
            .unwrap()
            .execute(&r)
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn late_start_exit_reconnect_and_restart() {
    let dir = std::env::temp_dir().join(format!("guest-wire-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let agent = Fixture::boot(dir.clone());
    let mut old = agent.connect();
    let hello = Session::negotiate(&old, Duration::from_secs(2)).unwrap();
    let (boot, incarnation) = (hello.boot, hello.incarnation);
    let handle = || Handle {
        boot: boot.clone(),
        incarnation: incarnation.clone(),
        id: "00000000000000000000000000000001".into(),
    };
    let start = || Request::Start {
        handle: handle(),
        argv: vec![
            "/bin/sh".into(),
            "-c".into(),
            "test -z \"$HOME\" || exit 99; cat; printf err >&2; exit 37".into(),
        ],
        env: vec![],
        cwd: "/".into(),
        stdin: b"input".to_vec(),
    };
    let mut frame = Vec::new();
    write_frame(&mut frame, 1, true, &start()).unwrap();
    // The new client sees absent while the old stream has only a frame prefix.
    old.write_all(&frame[..4]).unwrap();
    assert!(agent.request(Request::Inspect { handle: handle() }) == Response::Absent {});
    old.write_all(&frame[4..]).unwrap();
    drop(old);
    let end = Instant::now() + Duration::from_secs(3);
    loop {
        match agent.request(Request::Inspect { handle: handle() }) {
            Response::Exited { code: 37 } => break,
            Response::Running {} | Response::Absent {} if Instant::now() < end => {
                thread::sleep(Duration::from_millis(5))
            }
            _ => panic!("lost terminal result"),
        }
    }
    assert!(
        matches!(agent.request(Request::List {}),Response::Handles {handles} if handles == [handle()])
    );
    assert!(agent.request(start()) == Response::Conflict {});
    for (stdout, expected) in [(true, b"input".as_slice()), (false, b"err")] {
        loop {
            let stream = if stdout {
                Stream::Stdout
            } else {
                Stream::Stderr
            };
            match agent.request(Request::Output {
                handle: handle(),
                stream,
                offset: 0,
            }) {
                Response::Output {
                    bytes,
                    eof: true,
                    truncated: false,
                    start_offset: 0,
                } => {
                    assert_eq!(bytes, expected);
                    break;
                }
                Response::Output { eof: false, .. } if Instant::now() < end => {
                    thread::sleep(Duration::from_millis(5))
                }
                _ => panic!("output unavailable"),
            }
        }
    }
    assert!(agent.request(Request::Inspect { handle: handle() }) == Response::Exited { code: 37 });
    drop(agent);
    fs::create_dir(&dir).unwrap();
    let restarted = Fixture::boot(dir);
    assert!(restarted.request(Request::Inspect { handle: handle() }) == Response::Unknown {});
    // Drive the guest fence directly, bypassing the client's local stale-handle check.
    let mut stream = restarted.connect();
    let hello = Session::negotiate(&stream, Duration::from_secs(2)).unwrap();
    let fresh = Handle {
        boot: hello.boot,
        incarnation: hello.incarnation,
        id: handle().id,
    };
    write_frame(&mut stream, 1, true, &start()).unwrap();
    assert_eq!(
        hack_vm_protocol::read_frame::<Response>(&mut stream)
            .unwrap()
            .message,
        Response::Unknown {}
    );
    assert_eq!(
        restarted.request(Request::Start {
            handle: fresh,
            argv: vec!["/bin/true".into()],
            env: vec![],
            cwd: "/".into(),
            stdin: vec![]
        }),
        Response::Running {}
    );
}

#[test]
fn signal_exit_and_release_tombstone() {
    let dir = std::env::temp_dir().join(format!("guest-signal-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let agent = Fixture::boot(dir);
    let s = agent.connect();
    let hello = Session::negotiate(&s, Duration::from_secs(2)).unwrap();
    let handle = || Handle {
        boot: hello.boot.clone(),
        incarnation: hello.incarnation.clone(),
        id: "00000000000000000000000000000002".into(),
    };
    let start = || Request::Start {
        handle: handle(),
        argv: vec!["/bin/sleep".into(), "30".into()],
        env: vec![],
        cwd: "/".into(),
        stdin: vec![],
    };
    assert!(agent.request(start()) == Response::Running {});
    assert!(agent.request(Request::Release { handle: handle() }) == Response::Conflict {});
    assert!(
        agent.request(Request::Signal {
            handle: handle(),
            signal: hack_vm_protocol::Signal::Terminate
        }) == Response::Ack {}
    );
    let end = Instant::now() + Duration::from_secs(3);
    loop {
        match agent.request(Request::Inspect { handle: handle() }) {
            Response::Signaled { signal: 15 } => break,
            Response::Running {} if Instant::now() < end => thread::sleep(Duration::from_millis(5)),
            _ => panic!("missing terminating signal"),
        }
    }
    assert_eq!(
        agent.request(Request::Signal {
            handle: handle(),
            signal: hack_vm_protocol::Signal::Kill
        }),
        Response::Signaled { signal: 15 }
    );
    loop {
        match agent.request(Request::Release { handle: handle() }) {
            Response::Released {} => break,
            Response::Conflict {} if Instant::now() < end => {
                thread::sleep(Duration::from_millis(5))
            }
            _ => panic!("release did not settle"),
        }
    }
    assert!(agent.request(start()) == Response::Conflict {});
    assert!(agent.request(Request::Inspect { handle: handle() }) == Response::Released {});
}

#[test]
fn output_cap_still_drains_and_preserves_exit() {
    let dir = std::env::temp_dir().join(format!("guest-output-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let agent = Fixture::boot(dir);
    let Response::Facts {
        boot,
        incarnation,
        kernel,
        unix_ms,
        ..
    } = agent.request(Request::Facts {})
    else {
        panic!("missing facts")
    };
    assert!(!kernel.is_empty() && unix_ms > 0);
    let handle = Handle {
        boot,
        incarnation,
        id: "0".repeat(32),
    };
    assert_eq!(
        agent.request(Request::Start {
            handle: handle.clone(),
            argv: vec![
                "/bin/sh".into(),
                "-c".into(),
                "head -c 131072 /dev/zero; exit 9".into()
            ],
            env: vec![],
            cwd: "/".into(),
            stdin: vec![]
        }),
        Response::Running {}
    );
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        if let Response::Output {
            bytes, eof: true, ..
        } = agent.request(Request::Output {
            handle: handle.clone(),
            stream: Stream::Stdout,
            offset: 131072,
        }) {
            assert!(bytes.is_empty());
            break;
        }
        assert!(Instant::now() < end);
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        matches!(agent.request(Request::Output{handle:handle.clone(),stream:Stream::Stdout,offset:0}),Response::Output{start_offset:65536,bytes,truncated:true,..} if bytes.len()==4096)
    );
    loop {
        if agent.request(Request::Inspect {
            handle: handle.clone(),
        }) == (Response::Exited { code: 9 })
        {
            break;
        }
        assert!(Instant::now() < end);
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn complete_inventory_at_advertised_capacity() {
    let dir = std::env::temp_dir().join(format!("guest-inventory-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let agent = Fixture::boot(dir);
    let stream = agent.connect();
    let mut session = Session::negotiate(&stream, Duration::from_secs(2)).unwrap();
    let make = |n: u16| Handle {
        boot: session.boot.clone(),
        incarnation: session.incarnation.clone(),
        id: format!("{n:032x}"),
    };
    let handles: Vec<_> = (0..=session.max_jobs).map(make).collect();
    for (i, h) in handles.iter().enumerate() {
        let result = session
            .execute(&Request::Start {
                handle: h.clone(),
                argv: vec!["/missing-probe-program".into()],
                env: vec![],
                cwd: "/".into(),
                stdin: vec![],
            })
            .unwrap();
        assert_eq!(
            result,
            if i < usize::from(session.max_jobs) {
                Response::SpawnFailed {}
            } else {
                Response::Full {}
            }
        );
    }
    assert_eq!(
        session.execute(&Request::List {}).unwrap(),
        Response::Handles {
            handles: handles[..usize::from(session.max_jobs)].to_vec()
        }
    );
}
