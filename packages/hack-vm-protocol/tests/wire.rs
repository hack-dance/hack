use hack_vm_protocol::*;
const UUID: &str = "12345678-0000-4000-a000-000000000001";

fn check<T: Message + PartialEq>(value: T) {
    let mut bytes = Vec::new();
    write_frame(&mut bytes, &value).unwrap();
    assert!(read_frame::<T>(&bytes[..]).unwrap() == value);
    for end in 0..bytes.len() {
        assert!(read_frame::<T>(&bytes[..end]).is_err());
    }
}

fn handle() -> Handle {
    Handle {
        boot: UUID.into(),
        incarnation: UUID.into(),
        id: "a".repeat(32),
    }
}

#[test]
fn requests_and_replies() {
    use Request::*;
    check(Hello { min: 1, max: 2 });
    check(Facts {});
    check(List {});
    check(Start {
        handle: handle(),
        argv: vec!["true".into()],
        env: vec![("K".into(), "V".into())],
        cwd: "/".into(),
        stdin: vec![0, 255],
    });
    check(Inspect { handle: handle() });
    for signal in [
        hack_vm_protocol::Signal::Interrupt,
        hack_vm_protocol::Signal::Terminate,
        hack_vm_protocol::Signal::Kill,
    ] {
        check(Signal {
            handle: handle(),
            signal,
        });
    }
    for stream in [Stream::Stdout, Stream::Stderr] {
        check(Output {
            handle: handle(),
            stream,
            offset: u64::MAX,
        });
    }
    check(Release { handle: handle() });
    for reply in [
        Response::Welcome {
            version: 1,
            boot: UUID.into(),
            incarnation: UUID.into(),
        },
        Response::Facts {
            arch: "arch".into(),
            kernel: "kernel".into(),
            agent_version: "1".into(),
            unix_ms: 3,
            boot: UUID.into(),
            incarnation: UUID.into(),
        },
        Response::Absent {},
        Response::Running {},
        Response::SpawnFailed {},
        Response::Released {},
        Response::Exited { code: 37 },
        Response::Signaled { signal: 15 },
        Response::Output {
            bytes: vec![0, 255],
            eof: true,
            truncated: false,
        },
        Response::Ack {},
        Response::Unknown {},
        Response::Conflict {},
        Response::Full {},
        Response::Invalid {},
        Response::Handles {
            handles: vec![handle()],
        },
    ] {
        check(reply);
    }
}

fn start() -> Request {
    Request::Start {
        handle: handle(),
        argv: vec!["cmd".into()],
        env: vec![],
        cwd: "/".into(),
        stdin: vec![],
    }
}
fn encoded(v: &impl Message) -> Vec<u8> {
    let mut out = Vec::new();
    write_frame(&mut out, v).unwrap();
    out
}
fn bad_body(body: &[u8]) {
    let mut frame = (body.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(body);
    assert!(read_frame::<Request>(&frame[..]).is_err());
}
#[test]
fn malformed_payloads_and_versions() {
    for body in [
        b"".as_slice(),
        &[1, 255],
        &[2, 2],
        &[1, 2, 1, 2],
        &[1, 1, 0, 1, 0, 1, 0, 1],
    ] {
        bad_body(body);
    }
    let mut bytes = encoded(&start());
    let pos = bytes.windows(3).position(|w| w == b"cmd").unwrap();
    bytes[pos] = 255;
    assert!(read_frame::<Request>(&bytes[..]).is_err());
    for size in [0, 65537, u32::MAX] {
        assert_eq!(
            read_frame::<Request>(&size.to_be_bytes()[..]),
            Err(Error::Size)
        );
    }
    for (local, peer, want) in [
        ((1, 1), (1, 2), Some(1)),
        ((1, 2), (1, 1), Some(1)),
        ((1, 2), (2, 2), Some(2)),
        ((2, 2), (1, 1), None),
        ((1, 1), (2, 2), None),
        ((2, 1), (1, 2), None),
    ] {
        assert_eq!(common_version(local, peer), want);
    }
}
#[test]
fn limit_checks_apply_before_writing() {
    fn refuses(edit: impl FnOnce(&mut Request)) {
        let mut r = start();
        edit(&mut r);
        let mut out = Vec::new();
        assert!(write_frame(&mut out, &r).is_err());
        assert!(out.is_empty());
    }
    for n in [0, 129] {
        refuses(|r| {
            if let Request::Start { argv, .. } = r {
                *argv = vec!["x".into(); n]
            }
        });
    }
    refuses(|r| {
        if let Request::Start { argv, .. } = r {
            argv[0] = "a".repeat(4097)
        }
    });
    refuses(|r| {
        if let Request::Start { env, .. } = r {
            *env = vec![("n".into(), "v".into()); 129]
        }
    });
    for bad in [
        vec![("".into(), "".into())],
        vec![("N=".into(), "".into())],
        vec![("N".into(), "a".repeat(4097))],
        vec![("N".repeat(256), "".into())],
        vec![("N".into(), "".into()); 2],
    ] {
        refuses(|r| {
            if let Request::Start { env, .. } = r {
                *env = bad
            }
        });
    }
    refuses(|r| {
        if let Request::Start { handle, .. } = r {
            handle.id = "x".repeat(32)
        }
    });
    refuses(|r| {
        if let Request::Start { handle, .. } = r {
            handle.boot = "b".repeat(37)
        }
    });
    refuses(|r| {
        if let Request::Start { handle, .. } = r {
            handle.incarnation = UUID.to_uppercase()
        }
    });
    refuses(|r| {
        if let Request::Start { stdin, .. } = r {
            *stdin = vec![0; 32769]
        }
    });
    let mut max = start();
    if let Request::Start { argv, stdin, .. } = &mut max {
        *argv = vec!["a".repeat(4096); 7];
        argv.push(String::new());
        *stdin = vec![0; 32768];
    }
    let missing = MAX_FRAME + 4 - encoded(&max).len();
    if let Request::Start { argv, .. } = &mut max {
        argv.last_mut().unwrap().push_str(&"x".repeat(missing));
    }
    let wire = encoded(&max);
    assert_eq!(wire.len(), MAX_FRAME + 4);
    assert_eq!(read_frame::<Request>(&wire[..]).unwrap(), max);
    if let Request::Start { argv, .. } = &mut max {
        argv.last_mut().unwrap().push('x');
    }
    assert_eq!(write_frame(Vec::new(), &max), Err(Error::Size));
}

#[test]
fn wire_fixtures_and_redaction() {
    assert_eq!(
        encoded(&Request::Hello { min: 1, max: 2 }),
        [0, 0, 0, 6, 1, 1, 0, 1, 0, 2]
    );
    assert_eq!(
        encoded(&Response::Output {
            bytes: vec![0, 255],
            eof: true,
            truncated: false
        }),
        [0, 0, 0, 8, 2, 9, 0, 2, 0, 255, 1, 0]
    );
    let mut request = start();
    if let Request::Start { env, .. } = &mut request {
        env.push(("TEST".into(), "redaction-test".into()));
    }
    assert_eq!(format!("{request:?}"), "Start");
    let mut frame = encoded(&request);
    // Keep the outer frame intact while truncating each inner field.
    for end in 4..frame.len() {
        frame[..4].copy_from_slice(&((end - 4) as u32).to_be_bytes());
        assert!(read_frame::<Request>(&frame[..end]).is_err());
    }
}
