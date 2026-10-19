use super::*;
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

fn reply(flush: Value) -> Value {
    json!({"status":"ok","data":{"shutdown":true,"storage_flush":flush}})
}

fn flushed() -> Value {
    reply(json!({"version":1,"syncfs":"ok","remount_read_only":"ok"}))
}

fn refusal(response: &Value) -> (&'static str, String, String) {
    let error = verify(response).unwrap_err();
    (
        error.code,
        error.cause_code.clone().unwrap(),
        error.message.clone(),
    )
}

#[test]
fn explicit_syncfs_and_read_only_remount_results_are_trusted() {
    assert!(verify(&flushed()).is_ok());
    // Unknown sibling fields from a newer agent do not weaken or replace the required results.
    let mut extended = flushed();
    extended["data"]["storage_flush"]["elapsed_ms"] = json!(4);
    assert!(verify(&extended).is_ok());
}

#[test]
fn every_unproven_shutdown_reply_is_stop_uncertain_with_a_closed_cause() {
    let cases = [
        (
            json!({"status":"error","data":{"shutdown":true}}),
            "guest_shutdown_unacknowledged",
        ),
        (
            json!({"status":"ok","data":{"shutdown":false}}),
            "guest_shutdown_unacknowledged",
        ),
        (
            json!({"status":"ok","data":{"shutdown":"true"}}),
            "guest_shutdown_unacknowledged",
        ),
        (json!({"status":"ok"}), "guest_shutdown_unacknowledged"),
        // The pinned agent protocol 1 reply: acknowledged, but no flush evidence.
        (
            json!({"status":"ok","data":{"shutdown":true}}),
            "guest_flush_unreported",
        ),
        (reply(Value::Null), "guest_flush_unreported"),
        (reply(json!("ok")), "guest_flush_unreported"),
        (reply(json!(true)), "guest_flush_unreported"),
        (
            reply(json!({"syncfs":"ok","remount_read_only":"ok"})),
            "guest_flush_version_unsupported",
        ),
        (
            reply(json!({"version":2,"syncfs":"ok","remount_read_only":"ok"})),
            "guest_flush_version_unsupported",
        ),
        (
            reply(json!({"version":"1","syncfs":"ok","remount_read_only":"ok"})),
            "guest_flush_version_unsupported",
        ),
        (
            reply(json!({"version":1.5,"syncfs":"ok","remount_read_only":"ok"})),
            "guest_flush_version_unsupported",
        ),
        (
            reply(json!({"version":1,"remount_read_only":"ok"})),
            "guest_syncfs_unreported",
        ),
        (
            reply(json!({"version":1,"syncfs":true,"remount_read_only":"ok"})),
            "guest_syncfs_unreported",
        ),
        (
            reply(json!({"version":1,"syncfs":"OK","remount_read_only":"ok"})),
            "guest_syncfs_unreported",
        ),
        (
            reply(json!({"version":1,"syncfs":"failed","remount_read_only":"ok"})),
            "guest_syncfs_failed",
        ),
        // A failed syncfs is reported even when the remount result is also missing.
        (
            reply(json!({"version":1,"syncfs":"failed"})),
            "guest_syncfs_failed",
        ),
        (
            reply(json!({"version":1,"syncfs":"ok"})),
            "guest_remount_unreported",
        ),
        (
            reply(json!({"version":1,"syncfs":"ok","remount_read_only":null})),
            "guest_remount_unreported",
        ),
        (
            reply(json!({"version":1,"syncfs":"ok","remount_read_only":{"errno":16}})),
            "guest_remount_unreported",
        ),
        (
            reply(json!({"version":1,"syncfs":"ok","remount_read_only":"failed"})),
            "guest_remount_failed",
        ),
    ];
    for (response, cause) in cases {
        let (code, observed, message) = refusal(&response);
        assert_eq!(code, "stop_uncertain", "{response}");
        assert_eq!(observed, cause, "{response}");
        assert!(!message.is_empty());
    }
}

#[test]
fn refusals_never_echo_guest_values() {
    let sentinel = "synthetic-guest-private-value";
    for response in [
        json!({"status":sentinel,"data":{"shutdown":true}}),
        reply(json!(sentinel)),
        reply(json!({"version":sentinel,"syncfs":"ok","remount_read_only":"ok"})),
        reply(json!({"version":1,"syncfs":sentinel,"remount_read_only":"ok"})),
        reply(json!({"version":1,"syncfs":"ok","remount_read_only":sentinel})),
    ] {
        let error = verify(&response).unwrap_err();
        assert!(!serde_json::to_string(&error).unwrap().contains(sentinel));
    }
}

static NEXT_SOCKET: AtomicU64 = AtomicU64::new(0);

/// A private directory holding one fake agent socket, removed on drop.
struct FakeAgent {
    directory: PathBuf,
    socket: PathBuf,
}

impl FakeAgent {
    /// Serve exactly one framed reply and return the request the host sent.
    fn serve(response: Value) -> (Self, std::thread::JoinHandle<Value>) {
        let directory = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "hsp-{}-{}",
                std::process::id(),
                NEXT_SOCKET.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir(&directory).unwrap();
        let socket = directory.join("agent.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let worker = std::thread::spawn(move || {
            let (mut peer, _) = listener.accept().unwrap();
            let mut header = [0; 4];
            peer.read_exact(&mut header).unwrap();
            let mut body = vec![0; u32::from_be_bytes(header) as usize];
            peer.read_exact(&mut body).unwrap();
            let bytes = serde_json::to_vec(&response).unwrap();
            peer.write_all(&(bytes.len() as u32).to_be_bytes()).unwrap();
            peer.write_all(&bytes).unwrap();
            serde_json::from_slice(&body).unwrap()
        });
        (Self { directory, socket }, worker)
    }
}

impl Drop for FakeAgent {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn production_shutdown_request_requires_flush_proof_over_the_agent_socket() {
    let cases = [
        (flushed(), None),
        (
            json!({"status":"ok","data":{"shutdown":true}}),
            Some("guest_flush_unreported"),
        ),
        (
            reply(json!({"version":1,"syncfs":"failed","remount_read_only":"ok"})),
            Some("guest_syncfs_failed"),
        ),
        (
            reply(json!({"version":1,"syncfs":"ok","remount_read_only":"failed"})),
            Some("guest_remount_failed"),
        ),
        (
            reply(json!({"version":1,"syncfs":"ok"})),
            Some("guest_remount_unreported"),
        ),
    ];
    for (response, cause) in cases {
        let (agent, worker) = FakeAgent::serve(response);
        let result = request(&agent.socket);
        assert_eq!(worker.join().unwrap(), json!({"method":"shutdown"}));
        match cause {
            None => assert!(result.is_ok()),
            Some(cause) => {
                let error = result.unwrap_err();
                assert_eq!(error.code, "stop_uncertain");
                assert_eq!(error.cause_code.as_deref(), Some(cause));
            }
        }
    }
}

#[test]
fn unreachable_agent_keeps_the_transport_refusal() {
    let error = request(Path::new("/nonexistent/hack-shutdown-proof.sock")).unwrap_err();
    assert_eq!(error.code, "agent_protocol_uncertain");
}
