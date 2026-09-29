use super::*;
use std::{os::fd::AsFd, process::Command};

fn credential() -> Credential {
    Credential::from_private_input(
        Binding {
            owner: [1; 16],
            boot: [2; 16],
            endpoint: [3; 32],
            service: [4; 32],
        },
        [9; 32],
    )
    .unwrap()
}

#[test]
fn descriptor_round_trip_retains_authentication_and_requires_eof() {
    let original = credential();
    let authority = super::super::Authority::new(&original);
    let input = original.into_private_input().unwrap();
    let received =
        Credential::from_private_descriptor(input.0.into(), Duration::from_secs(1)).unwrap();
    let (client, hello) = received.begin().unwrap();
    let (server, challenge) = authority.challenge(&hello).unwrap();
    let (finish, proof) = client.answer(&challenge).unwrap();
    let (_, accepted) = server.finish(&proof).unwrap();
    finish.accept(&accepted).unwrap();

    let input = credential().into_private_input().unwrap();
    let mut bytes = Zeroizing::new(Vec::new());
    (&input.0).read_to_end(&mut bytes).unwrap();
    for length in [0, 1, LENGTH - 1, LENGTH + 1] {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        let mut altered = Zeroizing::new(bytes.to_vec());
        altered.resize(length, 0);
        writer.write_all(&altered).unwrap();
        drop(writer);
        assert!(
            Credential::from_private_descriptor(reader.into(), Duration::from_secs(1)).is_err()
        );
    }
    let (reader, mut writer) = UnixStream::pair().unwrap();
    writer.write_all(&bytes).unwrap();
    let start = Instant::now();
    assert!(Credential::from_private_descriptor(reader.into(), Duration::from_millis(30)).is_err());
    assert!(start.elapsed() < Duration::from_secs(1));
}

#[test]
fn regular_files_and_network_sockets_are_not_private_delivery() {
    let file = File::open(std::env::current_exe().unwrap()).unwrap();
    assert!(Credential::from_private_descriptor(file.into(), Duration::from_secs(1)).is_err());
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    assert!(Credential::from_private_descriptor(listener.into(), Duration::from_secs(1)).is_err());
    let (datagram, _peer) = std::os::unix::net::UnixDatagram::pair().unwrap();
    assert!(Credential::from_private_descriptor(datagram.into(), Duration::from_secs(1)).is_err());
}

#[test]
fn malformed_magic_and_zero_binding_or_key_are_refused() {
    let input = credential().into_private_input().unwrap();
    let mut original = Zeroizing::new(Vec::new());
    (&input.0).read_to_end(&mut original).unwrap();
    for range in [0..8, 8..24, 24..40, 40..72, 72..104, 104..LENGTH] {
        let mut bytes = Zeroizing::new(original.to_vec());
        bytes[range].fill(0);
        let (reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(&bytes).unwrap();
        drop(writer);
        assert!(
            Credential::from_private_descriptor(reader.into(), Duration::from_secs(1)).is_err()
        );
    }
}

#[test]
fn owned_child_receives_only_private_stdin() {
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "provider::relay_auth::provision::tests::private_stdin_child",
            "--nocapture",
        ])
        .env("HACK_PRIVATE_INPUT_TEST_CHILD", "1")
        .stdin(credential().into_private_input().unwrap().into_stdin())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!output.stdout.windows(8).any(|part| part == MAGIC));
}

#[test]
fn private_stdin_child() {
    if std::env::var_os("HACK_PRIVATE_INPUT_TEST_CHILD").is_none() {
        return;
    }
    let fd = std::io::stdin().as_fd().try_clone_to_owned().unwrap();
    let received = Credential::from_private_descriptor(fd, Duration::from_secs(1)).unwrap();
    assert!(received.key[..] == [9; 32]);
    assert!(received.binding.bytes() == credential().binding.bytes());
}
