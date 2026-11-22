//! Replay guest-execution model actions through the Linux socket and real child processes.
use hack_vm_protocol::{
    Handle, Request, Response, Stream,
    client::{GuestClient, Session},
    read_frame, write_frame,
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

struct Agent {
    dir: PathBuf,
    process: Child,
}

impl Agent {
    fn boot(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("guest-{label}-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let process = Command::new(env!("CARGO_BIN_EXE_hack-vm-agent"))
            .env_clear()
            .env("HOME", &dir)
            .arg(dir.join("agent.sock"))
            .spawn()
            .unwrap();
        Self { dir, process }
    }
    fn connect(&self) -> UnixStream {
        until(|| UnixStream::connect(self.dir.join("agent.sock")).ok())
    }
    fn request(&self, request: Request) -> Response {
        Session::negotiate(&self.connect(), Duration::from_secs(2))
            .unwrap()
            .execute(&request)
            .unwrap()
    }
    fn handle(&self, id: u16) -> Handle {
        let Response::Facts {
            boot, incarnation, ..
        } = self.request(Request::Facts {})
        else {
            panic!("missing facts")
        };
        Handle {
            boot,
            incarnation,
            id: format!("{id:032x}"),
        }
    }
    fn await_reply(&self, request: Request, expected: Response) -> Response {
        until(|| {
            let reply = self.request(request.clone());
            (reply == expected).then_some(reply)
        })
    }
}
impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}
fn until<T>(mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(result) = check() {
            return result;
        }
        assert!(Instant::now() < deadline, "timed out observing transition");
        thread::sleep(Duration::from_millis(5));
    }
}
fn start(handle: &Handle, argv: &[&str]) -> Request {
    Request::Start {
        handle: handle.clone(),
        argv: argv.iter().map(|s| s.to_string()).collect(),
        env: vec![],
        cwd: "/".into(),
        stdin: b"input".to_vec(),
    }
}
fn inspect(handle: &Handle) -> Request {
    Request::Inspect {
        handle: handle.clone(),
    }
}
fn release(handle: &Handle) -> Request {
    Request::Release {
        handle: handle.clone(),
    }
}

#[test]
fn lost_reply_record_release_new_id_and_restart() {
    let agent = Agent::boot("trace");
    let handle = agent.handle(1);
    let command = start(
        &handle,
        &[
            "/bin/sh",
            "-c",
            "test -z \"$HOME\" || exit 99; cat; printf err >&2; exit 37",
        ],
    );
    let mut old = agent.connect();
    Session::negotiate(&old, Duration::from_secs(2)).unwrap();
    let mut frame = Vec::new();
    write_frame(&mut frame, 1, true, &command).unwrap();
    old.write_all(&frame[..4]).unwrap();
    assert_eq!(agent.request(inspect(&handle)), Response::Absent {});
    old.write_all(&frame[4..]).unwrap();
    drop(old);
    let outcome = agent.await_reply(inspect(&handle), Response::Exited { code: 37 });
    assert_eq!(
        agent.request(Request::List {}),
        Response::Handles {
            handles: vec![handle.clone()]
        }
    );
    assert_eq!(agent.request(command.clone()), Response::Conflict {});
    for (stream, bytes) in [
        (Stream::Stdout, b"input".as_slice()),
        (Stream::Stderr, b"err"),
    ] {
        agent.await_reply(
            Request::Output {
                handle: handle.clone(),
                stream,
                offset: 0,
            },
            Response::Output {
                start_offset: 0,
                bytes: bytes.to_vec(),
                eof: true,
                truncated: false,
            },
        );
    }
    // Record is the host's action. Persist the observed response before Release.
    let mut receipt = fs::File::create_new(agent.dir.join("outcome")).unwrap();
    write_frame(&mut receipt, 1, true, &outcome).unwrap();
    receipt.sync_all().unwrap();
    assert_eq!(agent.request(release(&handle)), Response::Released {});
    assert_eq!(agent.request(command.clone()), Response::Conflict {});
    let next = agent.handle(2);
    assert_eq!(
        agent.request(start(&next, &["/missing-executable"])),
        Response::SpawnFailed {}
    );
    drop(agent);
    let fresh = Agent::boot("trace");
    let mut stream = fresh.connect();
    Session::negotiate(&stream, Duration::from_secs(2)).unwrap();
    write_frame(&mut stream, 1, true, &command).unwrap();
    assert_eq!(
        read_frame::<Response>(&mut stream).unwrap().message,
        Response::Unknown {}
    );
    assert_eq!(
        fresh.request(start(&fresh.handle(1), &["/bin/true"])),
        Response::Running {}
    );
}

#[test]
fn capacity_recovers_and_retired_ids_stay_fenced() {
    let agent = Agent::boot("capacity");
    let stream = agent.connect();
    let mut session = Session::negotiate(&stream, Duration::from_secs(2)).unwrap();
    let first = agent.handle(0);
    let capacity = session.max_jobs;
    let mut inventory = Vec::new();
    for counter in 0..320 {
        let h = Handle {
            id: format!("{counter:032x}"),
            ..first.clone()
        };
        let command = start(&h, &["/missing-executable"]);
        if counter == capacity {
            assert_eq!(session.execute(&command).unwrap(), Response::Full {});
            assert_eq!(
                session.execute(&Request::List {}).unwrap(),
                Response::Handles {
                    handles: inventory.clone()
                }
            );
            assert_eq!(
                session.execute(&release(&first)).unwrap(),
                Response::Released {}
            );
        }
        assert_eq!(session.execute(&command).unwrap(), Response::SpawnFailed {});
        if counter < capacity {
            inventory.push(h);
        } else {
            assert_eq!(
                session.execute(&release(&h)).unwrap(),
                Response::Released {}
            );
        }
    }
    assert_eq!(
        agent.request(start(&first, &["/bin/true"])),
        Response::Conflict {}
    );
}
