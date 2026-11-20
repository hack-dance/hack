#![cfg(unix)]
use hack_vm_protocol::{
    Error, Frame, Handle, Request, Response, VERSION,
    client::{Exchange, GuestClient, Session},
    read_frame, write_frame,
};
use std::{
    io::Write,
    os::unix::net::UnixStream,
    thread,
    time::{Duration, Instant},
};

const UUID: &str = "12345678-0000-4000-a000-000000000001";
fn welcome(s: &mut UnixStream, version: u16) {
    let hello = read_frame::<Request>(&mut *s).unwrap();
    assert!(matches!(
        hello,
        Frame {
            channel: 0,
            end: true,
            message: Request::Hello {
                min: 1,
                max: VERSION,
                ..
            }
        }
    ));
    write_frame(
        s,
        0,
        true,
        &Response::Welcome {
            version,
            capabilities: 0,
            max_frame: 65536,
            max_jobs: 16,
            output_retention: 65536,
            boot: UUID.into(),
            incarnation: UUID.into(),
        },
    )
    .unwrap();
}
#[test]
fn multiple_channels_fenced_handles_and_buffered_close() {
    let (host, mut guest) = UnixStream::pair().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(9))).unwrap();
    let old_read = host.read_timeout().unwrap();
    let old_write = host.write_timeout().unwrap();
    let server = thread::spawn(move || {
        welcome(&mut guest, 1);
        for channel in [1, 2] {
            let req = read_frame::<Request>(&mut guest).unwrap();
            assert_eq!(
                req,
                Frame {
                    channel,
                    end: true,
                    message: Request::List {}
                }
            );
            write_frame(
                &mut guest,
                channel,
                true,
                &Response::Handles { handles: vec![] },
            )
            .unwrap();
        }
    });
    let mut s = Session::negotiate(&host, Duration::from_secs(2)).unwrap();
    let stale = Handle {
        boot: UUID.into(),
        incarnation: "12345678-0000-4000-a000-000000000002".into(),
        id: "0".repeat(32),
    };
    assert_eq!(
        s.execute(&Request::Inspect { handle: stale }),
        Ok(Response::Unknown {})
    );
    for _ in 0..2 {
        assert_eq!(
            s.execute(&Request::List {}),
            Ok(Response::Handles { handles: vec![] })
        );
    }
    server.join().unwrap();
    assert_eq!(host.read_timeout().unwrap(), old_read);
    assert_eq!(host.write_timeout().unwrap(), old_write);
}
#[test]
fn closed_peer_with_pending_bytes_is_readable() {
    let (host, mut guest) = UnixStream::pair().unwrap();
    write_frame(&mut guest, 27, true, &Response::Exited { code: 37 }).unwrap();
    drop(guest);
    let mut io = Exchange {
        stream: &host,
        deadline: Instant::now() + Duration::from_secs(1),
    };
    assert_eq!(
        read_frame::<Response>(&mut io).unwrap().message,
        Response::Exited { code: 37 }
    );
    assert_eq!(read_frame::<Response>(&mut io), Err(Error::Closed));
}
#[test]
fn stalled_and_partial_frames_have_distinct_errors() {
    let (host, mut peer) = UnixStream::pair().unwrap();
    peer.write_all(&[0, 0]).unwrap();
    let mut io = Exchange {
        stream: &host,
        deadline: Instant::now() + Duration::from_millis(30),
    };
    assert_eq!(read_frame::<Response>(&mut io), Err(Error::Deadline));
    peer.write_all(&[0, 0, 0, 12, 2]).unwrap();
    drop(peer);
    io.deadline = Instant::now() + Duration::from_secs(1);
    assert_eq!(read_frame::<Response>(&mut io), Err(Error::Truncated));
    assert_eq!(
        Error::from(std::io::Error::from(std::io::ErrorKind::ConnectionRefused)),
        Error::Refused
    );
}
#[test]
fn incompatible_selection_or_reply_channel_is_refused() {
    for version in [1, 2] {
        let (host, mut peer) = UnixStream::pair().unwrap();
        let server = thread::spawn(move || {
            welcome(&mut peer, version);
            if version == 1 {
                read_frame::<Request>(&mut peer).unwrap();
                write_frame(&mut peer, 99, true, &Response::Ack {}).unwrap();
            }
        });
        let session = Session::offer(&host, Duration::from_secs(2), (1, 2), u64::MAX);
        if version == 1 {
            let mut session = session.unwrap();
            assert_eq!(session.execute(&Request::List {}), Err(Error::Invalid));
            assert_eq!(session.execute(&Request::List {}), Err(Error::Closed));
        } else {
            assert!(matches!(session, Err(Error::Invalid)));
        }
        server.join().unwrap();
    }
}
