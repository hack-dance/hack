//! Replay guest-execution model actions through the Linux socket and real child processes.
#![cfg(target_os = "linux")]
use hack_vm_protocol::{
    Handle, Request, Response, Stream,
    client::{GuestClient, Session},
    read_frame, write_frame,
};
use std::os::unix::{fs::DirBuilderExt, process::CommandExt};
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
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let mut launcher = Command::new(env!("CARGO_BIN_EXE_hack-vm-agent"));
        // Exercise inheritance from a launcher that auto-reaps children. Isolate the fixture group.
        unsafe {
            launcher.pre_exec(|| {
                libc::signal(libc::SIGCHLD, libc::SIG_IGN);
                libc::umask(0o027);
                Ok(())
            });
        }
        let process = launcher
            .process_group(0)
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

#[test]
fn group_isolation_and_inherited_umask() {
    let agent = Agent::boot("group");
    let handle = agent.handle(1);
    let cmd = start(
        &handle,
        &["/bin/sh", "-c", "umask; trap 'kill 0' EXIT; exit 0"],
    );
    assert_eq!(agent.request(cmd), Response::Running {});
    agent.await_reply(
        inspect(&handle),
        Response::Signaled {
            signal: libc::SIGTERM,
        },
    );
    agent.await_reply(
        Request::Output {
            handle: handle.clone(),
            stream: Stream::Stdout,
            offset: 0,
        },
        Response::Output {
            start_offset: 0,
            eof: true,
            truncated: false,
            bytes: b"0027\n".to_vec(),
        },
    );
    assert_eq!(agent.request(release(&handle)), Response::Released {});
}

#[test]
fn terminal_release_closes_inherited_pipes_and_unpins_leader() {
    let agent = Agent::boot("inherited");
    for (id, worker) in [(1, "/bin/sh"), (2, "setsid /bin/sh"), (3, "/bin/sh")] {
        let handle = agent.handle(id);
        let ready = agent.dir.join(format!("ready-{id}"));
        let gate = agent.dir.join(format!("close-{id}"));
        let done = agent.dir.join(format!("broken-{id}"));
        // The escaped worker waits until Release, then observes EPIPE. Bounded
        // lifetime also cleans it up if the assertion fails.
        let script = format!(
            "{worker} -c 'trap \"\" PIPE; echo $$ > \"$1\"; for n in $(seq 1 100); do test -f \"$2\" && break; sleep .05; done; echo x || touch \"$3\"' sh \"$1\" \"$2\" \"$3\" & echo $$; while ! test -e \"$1\"; do sleep .01; done; exit 37"
        );
        let cmd = start(
            &handle,
            &[
                "/bin/sh",
                "-c",
                &script,
                "sh",
                ready.to_str().unwrap(),
                gate.to_str().unwrap(),
                done.to_str().unwrap(),
            ],
        );
        assert_eq!(agent.request(cmd), Response::Running {});
        agent.await_reply(inspect(&handle), Response::Exited { code: 37 });
        let pid: u32 = until(|| {
            match agent.request(Request::Output {
                handle: handle.clone(),
                stream: Stream::Stdout,
                offset: 0,
            }) {
                Response::Output { bytes, .. } => {
                    std::str::from_utf8(&bytes).ok()?.trim().parse().ok()
                }
                _ => None,
            }
        });
        let proc = PathBuf::from(format!("/proc/{pid}/stat"));
        assert!(fs::read_to_string(&proc).unwrap().contains(") Z "));
        if id == 1 {
            assert_eq!(
                agent.request(Request::Signal {
                    handle: handle.clone(),
                    signal: hack_vm_protocol::Signal::Kill
                }),
                Response::Exited { code: 37 }
            );
            until(|| {
                matches!(
                    agent.request(Request::Output {
                        handle: handle.clone(),
                        stream: Stream::Stdout,
                        offset: 0
                    }),
                    Response::Output { eof: true, .. }
                )
                .then_some(())
            });
        }
        assert_eq!(agent.request(release(&handle)), Response::Released {});
        assert!(!proc.exists());
        fs::write(gate, b"").unwrap();
        if id == 2 {
            until(|| done.exists().then_some(()));
        } else {
            let worker: u32 = fs::read_to_string(ready).unwrap().trim().parse().unwrap();
            until(
                || match fs::read_to_string(format!("/proc/{worker}/stat")) {
                    Ok(stat) => stat.contains(") Z ").then_some(()),
                    Err(e) => (e.kind() == std::io::ErrorKind::NotFound).then_some(()),
                },
            );
            assert!(!done.exists());
        }
    }
}

#[test]
fn supervisor_drains_without_clients_and_release_refuses_running() {
    let agent = Agent::boot("drain");
    let handle = agent.handle(1);
    let gate = agent.dir.join("write");
    let done = agent.dir.join("finished");
    let cmd = start(
        &handle,
        &[
            "/bin/sh",
            "-c",
            "while ! test -e \"$1\"; do sleep .01; done; head -c 262144 /dev/zero; touch \"$2\"",
            "sh",
            gate.to_str().unwrap(),
            done.to_str().unwrap(),
        ],
    );
    assert_eq!(agent.request(cmd), Response::Running {});
    assert_eq!(agent.request(release(&handle)), Response::Conflict {});
    fs::write(gate, b"").unwrap();
    until(|| done.exists().then_some(()));
    agent.await_reply(inspect(&handle), Response::Exited { code: 0 });
    assert!(matches!(
        agent.request(Request::Output {
            handle,
            stream: Stream::Stdout,
            offset: 0
        }),
        Response::Output {
            truncated: true,
            start_offset: 196608,
            ..
        }
    ));
}

#[test]
fn peer_limit_and_partial_frame_deadline() {
    use std::io::Read;
    let agent = Agent::boot("peers");
    let mut peers = Vec::new();
    for _ in 0..16 {
        let stream = agent.connect();
        Session::negotiate(&stream, Duration::from_secs(2)).unwrap();
        peers.push(stream);
    }
    assert!(Session::negotiate(&agent.connect(), Duration::from_secs(2)).is_err());
    let mut stalled = peers.pop().unwrap();
    drop(peers);
    stalled.write_all(&[0]).unwrap();
    stalled
        .set_read_timeout(Some(Duration::from_secs(13)))
        .unwrap();
    assert_eq!(stalled.read(&mut [0]).unwrap(), 0);
    assert!(matches!(
        agent.request(Request::Facts {}),
        Response::Facts { .. }
    ));
}

#[test]
fn agent_crash_leaves_running_child_for_launcher_cleanup() {
    let mut agent = Agent::boot("crash");
    let handle = agent.handle(1);
    let gate = agent.dir.join("after-crash");
    let observed = agent.dir.join("survivor");
    let cmd = start(
        &handle,
        &[
            "/bin/sh",
            "-c",
            "for n in $(seq 1 100); do test -e \"$1\" && { touch \"$2\"; exit; }; sleep .05; done",
            "sh",
            gate.to_str().unwrap(),
            observed.to_str().unwrap(),
        ],
    );
    assert_eq!(agent.request(cmd), Response::Running {});
    agent.process.kill().unwrap();
    agent.process.wait().unwrap();
    fs::write(gate, b"").unwrap();
    until(|| observed.exists().then_some(()));
}

#[test]
fn kill_running_shell_reaches_its_worker() {
    let agent = Agent::boot("running-group");
    let handle = agent.handle(1);
    let marker = agent.dir.join("worker");
    let cmd = start(
        &handle,
        &[
            "/bin/sh",
            "-c",
            "sleep 8 & echo $! > \"$1\"; wait",
            "sh",
            marker.to_str().unwrap(),
        ],
    );
    assert_eq!(agent.request(cmd), Response::Running {});
    let pid: u32 = until(|| fs::read_to_string(&marker).ok()?.trim().parse().ok());
    assert_eq!(
        agent.request(Request::Signal {
            handle: handle.clone(),
            signal: hack_vm_protocol::Signal::Kill
        }),
        Response::Ack {}
    );
    agent.await_reply(
        inspect(&handle),
        Response::Signaled {
            signal: libc::SIGKILL,
        },
    );
    // Check before Release, which sends a second group kill.
    until(|| match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat.contains(") Z ").then_some(()),
        Err(e) => (e.kind() == std::io::ErrorKind::NotFound).then_some(()),
    });
    assert_eq!(agent.request(release(&handle)), Response::Released {});
}
