use super::*;
use crate::provider::{identity, relay_owner::transport::ClientExchange};
use std::{os::fd::AsFd, time::Instant};

fn peer() -> identity::ProcessIdentity {
    identity::observe(std::process::id() as i32).unwrap()
}

#[test]
fn stalled_control_does_not_block_data_or_another_retirement() {
    let mut owner = owner();
    let (first, one) = grant(&mut owner, 3);
    let (second, two) = grant(&mut owner, 4);
    let (mut first_client, _, _first_peer) = connected(&mut owner, &one, &first);
    let (mut second_client, mut traffic, mut second_peer) = connected(&mut owner, &two, &second);
    let (slow, mut slow_peer) = pair();
    owner
        .admit_control(slow, &peer(), Duration::from_secs(2))
        .unwrap();
    slow_peer.write_all(&[0]).unwrap();
    let request = request(&owner, vec![one.target]);
    let (server, client) = pair();
    owner
        .admit_control(server, &peer(), Duration::from_secs(1))
        .unwrap();
    let mut client =
        ClientExchange::new(client, &peer(), request.clone(), Duration::from_secs(1)).unwrap();
    second_client
        .write_all(&traffic.send.encode(Frame::Data(b"unaffected")).unwrap())
        .unwrap();
    let mut ack = None;
    for _ in 0..100 {
        owner.tick(Duration::ZERO).unwrap();
        ack = client.progress().unwrap();
        if ack.is_some() {
            break;
        }
    }
    assert!(ack.is_some());
    assert_eq!(first_client.read(&mut [0]).unwrap(), 0);
    assert_eq!(owner.connections(), 1);
    assert_eq!(owner.control_connections(), 1);
    assert_eq!(owner.control_stats().completed, 1);
    let mut bytes = [0; 10];
    second_peer.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"unaffected");
    assert!(!owner.entries[&two.target.service].retired);
}

#[test]
fn aggregate_admission_refuses_without_displacing_and_expiry_releases_slot() {
    let mut owner = owner();
    owner.control_capacity = 1;
    let (server, mut client) = pair();
    owner
        .admit_control(server, &peer(), Duration::from_millis(20))
        .unwrap();
    let deadline = owner.controls[0].deadline();
    let (excess, mut excess_peer) = pair();
    assert!(
        owner
            .admit_control(excess, &peer(), Duration::from_secs(1))
            .is_err()
    );
    assert_eq!(excess_peer.read(&mut [0]).unwrap(), 0);
    assert_eq!(owner.control_connections(), 1);
    owner.tick(Duration::from_secs(1)).unwrap();
    assert!(Instant::now() >= deadline);
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    assert_eq!(owner.control_connections(), 0);
    assert_eq!(owner.control_stats().timed_out, 1);
    assert_eq!(owner.control_stats().rejected, 1);
    let (replacement, _client) = pair();
    owner
        .admit_control(replacement, &peer(), Duration::from_secs(1))
        .unwrap();
    assert_eq!(owner.control_stats().peak_active, 1);
    assert_eq!(owner.control_stats().admitted, 2);
}

#[test]
fn idle_owner_waits_for_external_readiness_instead_of_periodic_ticks() {
    let mut owner = owner();
    let (wake, mut trigger) = pair();
    let (send, receive) = std::sync::mpsc::channel();
    let join = std::thread::spawn(move || {
        let result = owner.tick_with_wakeup(Duration::from_secs(1), wake.as_fd());
        send.send(result).unwrap();
    });
    assert!(matches!(
        receive.recv_timeout(Duration::from_millis(30)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout)
    ));
    trigger.write_all(&[1]).unwrap();
    assert!(
        receive
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap()
    );
    join.join().unwrap();
}

#[test]
fn malformed_and_stale_requests_release_only_their_control_slots() {
    let mut owner = owner();
    let (_listener, one) = grant(&mut owner, 3);
    let mut request = request(&owner, vec![one.target.clone()]);
    request.targets[0].generation[0] ^= 1;
    let mut clients = Vec::new();
    for bytes in [vec![b'{'], request.encode().unwrap()] {
        let (server, mut client) = pair();
        owner
            .admit_control(server, &peer(), Duration::from_secs(1))
            .unwrap();
        client
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .unwrap();
        client.write_all(&bytes).unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        clients.push(client);
    }
    ticks(&mut owner, 10);
    assert_eq!(owner.control_connections(), 0);
    assert_eq!(owner.control_stats().failed, 2);
    assert_eq!(owner.control_stats().completed, 0);
    assert!(!owner.entries[&one.target.service].retired);
    for mut client in clients {
        assert_eq!(client.read(&mut [0]).unwrap(), 0);
    }
}

#[test]
fn owner_drop_closes_control_and_relay_admissions() {
    let mut owner = owner();
    let (_listener, one) = grant(&mut owner, 3);
    let (control, mut controller) = pair();
    owner
        .admit_control(control, &peer(), Duration::from_secs(1))
        .unwrap();
    let (relay, mut guest) = pair();
    owner
        .admit(&one.target, relay, Duration::from_secs(1))
        .unwrap();
    drop(owner);
    assert_eq!(controller.read(&mut [0]).unwrap(), 0);
    assert_eq!(guest.read(&mut [0]).unwrap(), 0);
}
