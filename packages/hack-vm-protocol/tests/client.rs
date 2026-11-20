#![cfg(unix)]
use hack_vm_protocol::{
    Request, Response, VERSION,
    client::{GuestClient, Session},
    read_frame, write_frame,
};
use std::{os::unix::net::UnixStream, thread, time::Duration};

#[test]
fn session_negotiates_before_one_request() {
    for version in [VERSION, VERSION + 1] {
        let (host, mut guest) = UnixStream::pair().unwrap();
        let server = thread::spawn(move || {
            assert!(matches!(
                read_frame(&mut guest),
                Ok(Request::Hello {
                    min: VERSION,
                    max: VERSION
                })
            ));
            write_frame(
                &mut guest,
                &Response::Welcome {
                    version,
                    boot: "12345678-0000-4000-a000-000000000001".into(),
                    incarnation: "12345678-0000-4000-a000-000000000002".into(),
                },
            )
            .unwrap();
            if version == VERSION {
                assert!(matches!(read_frame(&mut guest), Ok(Request::Facts {})));
                write_frame(
                    &mut guest,
                    &Response::Facts {
                        boot: "12345678-0000-4000-a000-000000000001".into(),
                        incarnation: "12345678-0000-4000-a000-000000000002".into(),
                        arch: "guest".into(),
                        kernel: "kernel".into(),
                        agent_version: "1".into(),
                        unix_ms: 1,
                    },
                )
                .unwrap();
            }
        });
        let session = Session::negotiate(&host, Duration::from_secs(2));
        if version == VERSION {
            assert!(
                matches!(session.unwrap().execute(&Request::Facts {}),Ok(Response::Facts {arch,..}) if arch=="guest")
            );
        } else {
            assert!(session.is_err());
        }
        server.join().unwrap();
    }
}
