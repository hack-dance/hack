#[path = "../src/options.rs"]
mod options;
use options::{Mode, options, valid_address};
use std::net::Ipv4Addr;
fn parse(args: &str) -> Option<options::Options> {
    options(
        &args
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>(),
    )
}
#[test]
fn legacy_and_selected_loopback_are_exactly_slot_bound() {
    for slot in 0..32 {
        let selected = Ipv4Addr::new(127, 0, 0, slot + 2);
        assert!(valid_address(slot, selected));
        let value = parse(&format!(
            "--slot {slot} --listen-port 443 --listen-address {selected}"
        ))
        .unwrap();
        assert_eq!(value.slot, slot);
        assert_eq!(
            value.mode,
            Mode::Listener {
                address: selected,
                port: 443
            }
        );
    }
    assert_eq!(
        parse("--slot 31 --listen-port 443").unwrap().mode,
        Mode::Listener {
            address: Ipv4Addr::LOCALHOST,
            port: 443
        }
    );
    assert_eq!(
        parse("--slot 0 --application-fd 3").unwrap().mode,
        Mode::Application(3)
    );
}
#[test]
fn wildcard_foreign_slot_and_noncanonical_addresses_refuse() {
    for address in [
        "0.0.0.0",
        "127.0.0.3",
        "127.1.0.2",
        "192.168.1.2",
        "::1",
        "127.000.0.2",
        "127.0.0.2:443",
    ] {
        assert!(
            parse(&format!(
                "--slot 0 --listen-port 443 --listen-address {address}"
            ))
            .is_none()
        );
    }
    for args in [
        "--slot 32 --listen-port 443 --listen-address 127.0.0.34",
        "--slot 0 --application-fd 3 --listen-address 127.0.0.2",
        "--slot 0 --listen-address 127.0.0.2",
        "--slot 0 --listen-port 0 --listen-address 127.0.0.2",
    ] {
        assert!(parse(args).is_none());
    }
}
// Linux supplies all of 127/8 on loopback; macOS may require configured aliases.
// This test qualifies ordinary same-port isolation, not authenticated relay traffic.
#[cfg(target_os = "linux")]
#[test]
fn distinct_slot_addresses_can_bind_same_port() {
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
    };
    let first = TcpListener::bind((Ipv4Addr::new(127, 0, 0, 2), 0)).unwrap();
    let port = first.local_addr().unwrap().port();
    let second = TcpListener::bind((Ipv4Addr::new(127, 0, 0, 3), port)).unwrap();
    assert!(TcpListener::bind((Ipv4Addr::new(127, 0, 0, 2), port)).is_err());
    for (listener, address, byte) in [
        (first, Ipv4Addr::new(127, 0, 0, 2), b'A'),
        (second, Ipv4Addr::new(127, 0, 0, 3), b'B'),
    ] {
        let mut client = TcpStream::connect((address, port)).unwrap();
        client.write_all(&[byte]).unwrap();
        let (mut accepted, _) = listener.accept().unwrap();
        accepted
            .set_read_timeout(Some(std::time::Duration::from_secs(1)))
            .unwrap();
        let mut actual = [0];
        accepted.read_exact(&mut actual).unwrap();
        assert_eq!(actual, [byte]);
    }
}
