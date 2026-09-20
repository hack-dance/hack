use super::*;

const DATA: &[u8] = b"HKF1\x01\x00\x00\x05hello";
const FIN: &[u8] = b"HKF1\x02\x00\x00\x00";
const RESET: &[u8] = b"HKF1\x03\x00\x00\x00";

#[test]
fn independent_wire_vectors_and_bounded_sender() {
    let mut encoder = Encoder::default();
    assert_eq!(encoder.encode(Frame::Data(b"hello")).unwrap(), DATA);
    assert!(encoder.encode(Frame::Data(&[])).is_err());
    assert!(encoder.encode(Frame::Data(&vec![0; MAX_DATA + 1])).is_err());
    let packet = encoder.encode(Frame::Data(&vec![7; MAX_DATA])).unwrap();
    assert_eq!(&packet[..8], b"HKF1\x01\x00\x40\x00");
    assert_eq!(packet.len(), MAX_DATA + 8);
    assert_eq!(encoder.encode(Frame::Fin).unwrap(), FIN);
    assert!(encoder.encode(Frame::Data(b"late")).is_err());
    assert!(encoder.encode(Frame::Fin).is_err());
    assert_eq!(encoder.encode(Frame::Reset).unwrap(), RESET);
    assert!(encoder.encode(Frame::Reset).is_err());
}

#[test]
fn every_split_preserves_payload_and_explicit_eof() {
    for split in 0..=DATA.len() {
        let mut decoder = Decoder::default();
        let (used, frame) = decoder.push(&DATA[..split]).unwrap();
        assert_eq!(used, split);
        if split == DATA.len() {
            assert_eq!(frame, Some(Frame::Data(b"hello")));
        } else {
            assert!(frame.is_none());
            let (used, frame) = decoder.push(&DATA[split..]).unwrap();
            assert_eq!(used, DATA.len() - split);
            assert_eq!(frame, Some(Frame::Data(b"hello")));
        }
        for (i, byte) in FIN.iter().enumerate() {
            let (used, frame) = decoder.push(&[*byte]).unwrap();
            assert_eq!(used, 1);
            assert_eq!(frame, (i == FIN.len() - 1).then_some(Frame::Fin));
        }
        decoder.finish_transport().unwrap();
    }
}

#[test]
fn coalesced_input_stops_at_one_frame_for_backpressure() {
    let wire = [DATA, DATA, FIN].concat();
    let mut decoder = Decoder::default();
    let (used, frame) = decoder.push(&wire).unwrap();
    assert_eq!(used, DATA.len());
    assert_eq!(frame, Some(Frame::Data(b"hello")));
    let (used2, frame) = decoder.push(&wire[used..]).unwrap();
    assert_eq!(used2, DATA.len());
    assert_eq!(frame, Some(Frame::Data(b"hello")));
    assert_eq!(
        decoder.push(&wire[used + used2..]).unwrap().1,
        Some(Frame::Fin)
    );
    decoder.finish_transport().unwrap();
}

#[test]
fn every_truncated_prefix_is_terminal_and_never_graceful() {
    for length in 0..DATA.len() {
        let mut decoder = Decoder::default();
        decoder.push(&DATA[..length]).unwrap();
        assert!(decoder.finish_transport().is_err());
        assert!(decoder.push(FIN).is_err());
    }
    for length in 0..FIN.len() {
        let mut decoder = Decoder::default();
        decoder.push(DATA).unwrap();
        decoder.push(&FIN[..length]).unwrap();
        assert!(decoder.finish_transport().is_err());
    }
}

#[test]
fn invalid_headers_poison_without_reading_advertised_payload() {
    for header in [
        &b"HKF2\x01\x00\x00\x01"[..],
        b"HKF1\x04\x00\x00\x00",
        b"HKF1\x01\x00\x00\x00",
        b"HKF1\x01\x00\x40\x01",
        b"HKF1\x01\xff\xff\xff",
        b"HKF1\x02\x00\x00\x01",
        b"HKF1\x03\x00\x00\x01",
    ] {
        let mut decoder = Decoder::default();
        assert!(decoder.push(header).is_err());
        assert!(decoder.push(FIN).is_err());
        assert!(decoder.finish_transport().is_err());
    }
}

#[test]
fn fin_does_not_allow_more_data_but_reset_can_abort_the_reverse_flow() {
    for invalid in [DATA, FIN] {
        let mut decoder = Decoder::default();
        decoder.push(FIN).unwrap();
        assert!(decoder.push(invalid).is_err());
        assert!(decoder.finish_transport().is_err());
    }
    for prefix in [&[][..], FIN] {
        let mut decoder = Decoder::default();
        decoder.push(prefix).unwrap();
        assert_eq!(decoder.push(RESET).unwrap().1, Some(Frame::Reset));
        assert!(decoder.push(DATA).is_err());
        assert!(decoder.finish_transport().is_err());
    }
}

#[test]
fn maximum_payload_round_trips_with_one_byte_fragments() {
    let payload: Vec<_> = (0..MAX_DATA).map(|n| (n % 251) as u8).collect();
    let wire = Encoder::default().encode(Frame::Data(&payload)).unwrap();
    let mut decoder = Decoder::default();
    for (i, byte) in wire.iter().enumerate() {
        let (used, frame) = decoder.push(&[*byte]).unwrap();
        assert_eq!(used, 1);
        if i + 1 == wire.len() {
            assert_eq!(frame, Some(Frame::Data(&payload)));
        } else {
            assert!(frame.is_none());
        }
    }
}
