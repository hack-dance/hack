use super::*;

fn binding() -> Binding {
    Binding {
        owner: [1; 16],
        boot: [2; 16],
        endpoint: [3; 32],
        service: [4; 32],
    }
}
fn credential() -> Credential {
    Credential::from_private_input(binding(), [7; 32]).unwrap()
}
fn session(authority: &Authority, credential: &Credential) -> AuthorizedSession {
    let (client, hello) = credential.begin().unwrap();
    let (server, response) = authority.challenge(&hello).unwrap();
    let (client, proof) = client.answer(&response).unwrap();
    let (session, accepted) = server.finish(&proof).unwrap();
    client.accept(&accepted).unwrap();
    session
}
#[test]
fn independent_python_hmac_transcript_vector() {
    let value = tag(mac(&[7; 32], b'S', binding(), &[5; 32], &[6; 32]).unwrap());
    let hex: String = value.iter().map(|v| format!("{v:02x}")).collect();
    assert_eq!(
        hex,
        "fae96a72c8b7f5084f3391ce8cb57cb7d7d2bd2c7cf8b2e4b05e7560bb4f9a43"
    );
}
#[test]
fn mutual_proof_admits_only_until_revocation() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let session = session(&authority, &credential);
    assert_eq!(session.with_active(|| 42).unwrap(), 42);
    authority.revoke();
    authority.revoke();
    let mut ran = false;
    assert!(session.with_active(|| ran = true).is_err());
    assert!(!ran);
    assert!(authority.challenge(&credential.begin().unwrap().1).is_err());
    assert!(authority.core.key.lock().unwrap().is_none());
}
#[test]
fn binding_version_and_length_mutations_refuse() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let (_, hello) = credential.begin().unwrap();
    for index in [0, 8, 24, 40, 72] {
        let mut changed = hello;
        changed[index] ^= 1;
        assert!(authority.challenge(&changed).is_err());
    }
    for length in [0, 7, 135] {
        assert!(authority.challenge(&hello[..length]).is_err());
    }
    assert!(
        authority
            .challenge(&[hello.as_slice(), &[0]].concat())
            .is_err()
    );
    let mut empty = binding();
    empty.boot = [0; 16];
    assert!(Credential::from_private_input(empty, [7; 32]).is_err());
    assert!(Credential::from_private_input(binding(), [0; 32]).is_err());
}
#[test]
fn wrong_key_and_altered_server_nonce_or_tag_refuse() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let wrong = Credential::from_private_input(binding(), [8; 32]).unwrap();
    let (client, hello) = wrong.begin().unwrap();
    let (_, response) = authority.challenge(&hello).unwrap();
    assert!(client.answer(&response).is_err());
    for index in [0, 31, 32, 63] {
        let (client, hello) = credential.begin().unwrap();
        let (_, mut response) = authority.challenge(&hello).unwrap();
        response[index] ^= 1;
        assert!(client.answer(&response).is_err());
    }
}
#[test]
fn reflection_and_old_challenge_replay_refuse() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let (client, hello) = credential.begin().unwrap();
    let (server, response) = authority.challenge(&hello).unwrap();
    let (client, proof) = client.answer(&response).unwrap();
    assert!(server.finish(&response[32..]).is_err());
    assert!(client.accept(&proof).is_err());
    let (fresh, response2) = authority.challenge(&hello).unwrap();
    assert_ne!(&response[..32], &response2[..32]);
    assert!(fresh.finish(&proof).is_err());
}
#[test]
fn replayed_server_acceptance_does_not_authorize_a_fresh_client() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let (client, hello) = credential.begin().unwrap();
    let (server, response) = authority.challenge(&hello).unwrap();
    let (_, proof) = client.answer(&response).unwrap();
    let (_, old) = server.finish(&proof).unwrap();
    let (client, hello) = credential.begin().unwrap();
    let (_, response) = authority.challenge(&hello).unwrap();
    let (client, _) = client.answer(&response).unwrap();
    assert!(client.accept(&old).is_err());
}
#[test]
fn revoke_at_each_completion_boundary_prevents_effects() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let (client, hello) = credential.begin().unwrap();
    let (server, response) = authority.challenge(&hello).unwrap();
    let (_, proof) = client.answer(&response).unwrap();
    authority.revoke();
    assert!(server.finish(&proof).is_err());
    let authority = Authority::new(&credential);
    let (client, hello) = credential.begin().unwrap();
    let (server, response) = authority.challenge(&hello).unwrap();
    let (client, proof) = client.answer(&response).unwrap();
    let (session, accepted) = server.finish(&proof).unwrap();
    authority.revoke();
    client.accept(&accepted).unwrap();
    assert!(session.with_active(|| ()).is_err());
}
#[test]
fn expired_handshake_stages_refuse_without_sleeping() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let past = Instant::now() - Duration::from_secs(1);
    let (mut client, hello) = credential.begin().unwrap();
    let (_, response) = authority.challenge(&hello).unwrap();
    client.deadline = past;
    assert!(client.answer(&response).is_err());
    let (client, hello) = credential.begin().unwrap();
    let (mut server, response) = authority.challenge(&hello).unwrap();
    let (mut client, proof) = client.answer(&response).unwrap();
    server.deadline = past;
    assert!(server.finish(&proof).is_err());
    client.deadline = past;
    assert!(client.accept(&[0; 32]).is_err());
}
#[test]
fn revoke_waits_for_an_admitted_effect_then_refuses_later_work() {
    use std::{sync::mpsc, thread};
    let credential = credential();
    let authority = Authority::new(&credential);
    let session = session(&authority, &credential);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    thread::scope(|scope| {
        let session = &session;
        let effect = scope.spawn(move || {
            session
                .with_active(|| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                    7
                })
                .unwrap()
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(authority.core.key.try_lock().is_err());
        let revoker = scope.spawn(|| authority.revoke());
        release_tx.send(()).unwrap();
        assert_eq!(effect.join().unwrap(), 7);
        revoker.join().unwrap();
    });
    assert!(session.with_active(|| ()).is_err());
}
#[test]
fn panic_poisons_admission_and_revoke_still_erases_stored_key() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let session = session(&authority, &credential);
    assert!(
        std::panic::catch_unwind(|| session.with_active(|| panic!("synthetic effect failure")))
            .is_err()
    );
    assert!(session.with_active(|| ()).is_err());
    assert!(authority.challenge(&credential.begin().unwrap().1).is_err());
    authority.revoke();
    assert!(
        authority
            .core
            .key
            .lock()
            .unwrap_err()
            .into_inner()
            .is_none()
    );
}
#[test]
fn malformed_proof_lengths_and_bytes_do_not_leak_inputs() {
    let credential = credential();
    let authority = Authority::new(&credential);
    for length in [0, 1, 31, 32, 33, 1024] {
        let (_, hello) = credential.begin().unwrap();
        let (server, _) = authority.challenge(&hello).unwrap();
        let error = server.finish(&vec![b'X'; length]).err().unwrap();
        assert_eq!(error.code, "relay_auth_refused");
        assert!(!error.message.contains("XXXX"));
    }
}

#[test]
fn independent_derived_key_record_vector_and_all_transcript_fields() {
    use crate::provider::relay_frame::Frame;
    let mut client = traffic(&[7; 32], binding(), &[5; 32], &[6; 32], true).unwrap();
    let wire = client.send.encode(Frame::Data(b"hello")).unwrap();
    assert!(client.receive.push(&wire).is_err());
    let hex: String = wire.iter().map(|v| format!("{v:02x}")).collect();
    assert_eq!(
        hex,
        "484b49310000000d0000000000000000484b46310100000568656c6c6faefe8a20d1078a8d30a77937519be8b2d9706069f34e9a23b6f910b0386f0b28"
    );
    let mut server = traffic(&[7; 32], binding(), &[5; 32], &[6; 32], false).unwrap();
    assert_eq!(
        server.receive.push(&wire).unwrap().1,
        Some(Frame::Data(b"hello"))
    );
    for field in 0..7 {
        let mut binding = binding();
        let mut key = [7; 32];
        let mut client = [5; 32];
        let mut server = [6; 32];
        match field {
            0 => binding.owner[0] ^= 1,
            1 => binding.boot[0] ^= 1,
            2 => binding.endpoint[0] ^= 1,
            3 => binding.service[0] ^= 1,
            4 => key[0] ^= 1,
            5 => client[0] ^= 1,
            _ => server[0] ^= 1,
        }
        let mut other = traffic(&key, binding, &client, &server, false).unwrap();
        assert!(other.receive.push(&wire).is_err());
    }
}

fn poll_revocation(watch: &RevocationWatch, timeout_ms: i32) -> i32 {
    use std::os::fd::{AsFd, AsRawFd};
    let mut fd = libc::pollfd {
        fd: watch.as_fd().as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: one initialized pollfd with a live borrowed descriptor; poll retains
    // no pointer and the watch remains owned through the bounded call.
    let count = unsafe { libc::poll(&mut fd, 1, timeout_ms) };
    assert!(count >= 0, "fixture poll failed");
    if count > 0 {
        assert_ne!(fd.revents & (libc::POLLIN | libc::POLLHUP), 0);
    }
    count
}
#[test]
fn revocation_watch_is_quiet_shared_and_level_triggered() {
    use std::os::fd::{AsFd, AsRawFd};
    let credential = credential();
    let authority = Authority::new(&credential);
    let session = session(&authority, &credential);
    assert!(authority.core.signal.lock().unwrap().is_none());
    let watch = session.watch_revocation().unwrap();
    let others: Vec<_> = (0..64)
        .map(|_| session.watch_revocation().unwrap())
        .collect();
    assert!(
        others
            .iter()
            .all(|other| other.as_fd().as_raw_fd() == watch.as_fd().as_raw_fd())
    );
    assert_eq!(poll_revocation(&watch, 0), 0);
    assert!(!watch.is_revoked().unwrap());
    authority.revoke();
    authority.revoke();
    assert!(session.watch_revocation().is_err());
    assert!(authority.core.signal.lock().unwrap().is_none());
    for other in others {
        assert_eq!(poll_revocation(&other, 0), 1);
        assert!(other.is_revoked().unwrap());
    }
    for _ in 0..3 {
        assert!(watch.is_revoked().unwrap());
        assert_eq!(poll_revocation(&watch, 0), 1);
    }
    assert!(session.with_active(|| ()).is_err());
}
#[test]
fn revocation_wakes_a_blocked_poller_without_a_timer_loop() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let session = session(&authority, &credential);
    let watch = session.watch_revocation().unwrap();
    std::thread::scope(|scope| {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let waiter = scope.spawn(move || {
            ready_tx.send(()).unwrap();
            assert_eq!(poll_revocation(&watch, 2000), 1);
            assert!(watch.is_revoked().unwrap());
        });
        ready_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        authority.revoke();
        waiter.join().unwrap();
    });
}
#[test]
fn racing_watch_registration_cannot_miss_revocation() {
    for _ in 0..32 {
        let credential = credential();
        let authority = Authority::new(&credential);
        let session = session(&authority, &credential);
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let subscriber = scope.spawn(|| {
                barrier.wait();
                session.watch_revocation()
            });
            let revoker = scope.spawn(|| {
                barrier.wait();
                authority.revoke()
            });
            revoker.join().unwrap();
            match subscriber.join().unwrap() {
                Ok(watch) => {
                    assert_eq!(poll_revocation(&watch, 0), 1);
                    assert!(watch.is_revoked().unwrap());
                }
                Err(error) => assert_eq!(error.code, "relay_auth_refused"),
            }
        });
    }
}
#[test]
fn dropping_owner_and_sessions_notifies_without_retaining_authority() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let session = session(&authority, &credential);
    let watch = session.watch_revocation().unwrap();
    let core = Arc::downgrade(&authority.core);
    drop(authority);
    assert!(!watch.is_revoked().unwrap());
    drop(session);
    assert!(core.upgrade().is_none());
    assert_eq!(poll_revocation(&watch, 0), 1);
    assert!(watch.is_revoked().unwrap());
}
#[test]
fn poisoned_admission_still_notifies_when_revoked() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let session = session(&authority, &credential);
    let watch = session.watch_revocation().unwrap();
    assert!(
        std::panic::catch_unwind(|| session.with_active(|| panic!("synthetic failure"))).is_err()
    );
    assert!(session.watch_revocation().is_err());
    authority.revoke();
    assert_eq!(poll_revocation(&watch, 0), 1);
    assert!(watch.is_revoked().unwrap());
}

#[test]
fn revocation_wakes_even_when_a_fork_equivalent_writer_copy_survives() {
    let credential = credential();
    let authority = Authority::new(&credential);
    let session = session(&authority, &credential);
    let watch = session.watch_revocation().unwrap();
    let writer_copy = authority
        .core
        .signal
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .duplicate_writer()
        .unwrap();
    authority.revoke();
    assert_eq!(poll_revocation(&watch, 0), 1);
    assert!(watch.is_revoked().unwrap());
    drop(writer_copy);
}
