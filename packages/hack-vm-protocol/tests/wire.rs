use hack_vm_protocol::*;
use serde::{Deserialize, Serialize};

fn check<T: Serialize + for<'a> Deserialize<'a> + PartialEq>(value: T) {
    let mut bytes = Vec::new();
    write_frame(&mut bytes, &value).unwrap();
    assert!(read_frame::<T>(&bytes[..]).unwrap() == value);
    for end in 0..bytes.len() {
        assert!(read_frame::<T>(&bytes[..end]).is_err());
    }
}

fn handle() -> Handle {
    Handle {
        boot: "b".into(),
        incarnation: "a".into(),
        id: "i".into(),
    }
}

#[test]
fn requests_and_replies() {
    use Request::*;
    check(Hello { min: 1, max: 2 });
    check(Facts {});
    check(Start {
        handle: handle(),
        argv: vec!["true".into()],
        env: vec![("K".into(), "V".into())],
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
            boot: "b".into(),
            incarnation: "a".into(),
        },
        Response::Facts {
            arch: "arch".into(),
            boot: "b".into(),
            incarnation: "a".into(),
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
    ] {
        check(reply);
    }
}

#[test]
fn rejects_bad_frames() {
    for body in [
        b"".as_slice(),
        b"{}",
        b"\xff",
        br#"{"method":"other"}"#,
        br#"{"method":"facts","extra":true}"#,
        br#"{"method":"facts"}{}"#,
        br#"{"status":"ack"}"#,
        br#"{"method":"inspect","handle":null}"#,
    ] {
        let mut bytes = (body.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(body);
        assert!(read_frame::<Request>(&bytes[..]).is_err());
    }
    assert!(matches!(
        read_frame::<Request>(&u32::MAX.to_be_bytes()[..]),
        Err(Error::Size)
    ));
    let mut out = Vec::new();
    assert_eq!(
        write_frame(&mut out, &"x".repeat(MAX_FRAME)),
        Err(Error::Size)
    );
    assert!(out.is_empty());
    let boundary = "x".repeat(MAX_FRAME - 2);
    write_frame(&mut out, &boundary).unwrap();
    assert_eq!(read_frame::<String>(&out[..]).unwrap(), boundary);
}
#[test]
fn version_overlap() {
    for (min, max, want) in [
        (0, 0, None),
        (0, 1, Some(1)),
        (1, 1, Some(1)),
        (1, 2, Some(1)),
        (2, 1, None),
        (2, 3, None),
    ] {
        assert_eq!(negotiate(min, max), want);
    }
}
