//! Transport reads and HTTP chunks have no relationship to Docker mux frames.
use super::*;

#[test]
fn malformed_streams_name_the_phase_without_echoing_bytes() {
    for (wire, phase, detail) in [
        (b"HTTP/1.1 500 private-diagnostic-canary\r\n\r\n".to_vec(), "status-line", "expected HTTP/1.1 200"),
        (b"HTTP/1.1 200 OK\r\n\r\nprivate-diagnostic-canary".to_vec(), "frame-header", "first byte is not stdout"),
        ([b"HTTP/1.1 200 OK\r\n\r\n".as_slice(), &[1, 9, 0, 0, 0, 0, 0, 0], b"private-diagnostic-canary"].concat(), "frame-header", "reserved bytes are nonzero"),
        (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\ninvalid-size\r\nprivate-diagnostic-canary".to_vec(), "http-framing", "expected a hexadecimal chunk size"),
        ([b"HTTP/1.1 200 OK\r\n\r\n".as_slice(), &[1, 0, 0, 0, 0, 0, 0, 20], b"hi"].concat(), "payload", "before its declared length"),
    ] {
        let error = copy(&wire[..], &mut Vec::new(), "web", "id").unwrap_err();
        let reply = serde_json::to_value(&error).unwrap();
        assert_eq!(error.code, "native_log_stream_uncertain");
        assert_eq!(reply["log_phase"], phase);
        assert_eq!(reply["message_fixed"], true);
        assert!(error.message.contains(detail));
        assert!(!error.message.contains("private-diagnostic-canary"));
    }
}

#[test]
fn periodic_inspection_failure_keeps_its_code_and_fixed_detail() {
    let (stream, _writer) = UnixStream::pair().unwrap();
    let deadline = Cell::new(None);
    let stopped = Cell::new(false);
    let check_error = RefCell::new(None);
    let check = || {
        Err(CandidateError::new(
            "engine_protocol",
            "Engine request failed or timed out; its effect may be uncertain. No request was replayed.",
        ))
    };
    let mut guarded = Guarded {
        stream,
        check: &check,
        last: Instant::now() - Duration::from_secs(5),
        deadline: &deadline,
        stopped: &stopped,
        check_error: &check_error,
        running: true,
        stopped_since: None,
    };
    assert!(guarded.read(&mut [0; 1]).is_err());
    let reply = serde_json::to_value(check_error.into_inner().unwrap()).unwrap();
    assert_eq!(reply["code"], "engine_protocol");
    assert_eq!(reply["log_phase"], "periodic-check");
    assert_eq!(reply["message_fixed"], true);
    assert!(
        reply["message"]
            .as_str()
            .unwrap()
            .contains("failed or timed out")
    );
    assert!(!stopped.get());
}

struct Fragmented<'a> {
    bytes: &'a [u8],
    boundaries: Vec<usize>,
    position: usize,
    limit: usize,
}
impl Read for Fragmented<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let end = self
            .boundaries
            .iter()
            .copied()
            .find(|end| *end > self.position)
            .unwrap_or(self.bytes.len());
        let size = output.len().min(self.limit).min(end - self.position);
        output[..size].copy_from_slice(&self.bytes[self.position..self.position + size]);
        self.position += size;
        Ok(size)
    }
}
fn mux(stream: u8, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![stream, 0, 0, 0];
    bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend_from_slice(payload);
    bytes
}
fn assert_payloads(input: impl Read, expected: [&[u8]; 2]) {
    let mut output = Vec::new();
    copy(input, &mut output, "web", &"a".repeat(64)).unwrap();
    let mut streams = [Vec::new(), Vec::new()];
    let mut attached = 0;
    for line in output
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        assert!(line.len() < 6000);
        let event: serde_json::Value = serde_json::from_slice(line).unwrap();
        if event["kind"] == "native-log-attached" {
            attached += 1;
            continue;
        }
        assert_eq!(event["kind"], "native-log-chunk");
        let stream = match event["stream"].as_str().unwrap() {
            "stdout" => 0,
            "stderr" => 1,
            _ => panic!("unexpected stream"),
        };
        let bytes = STANDARD.decode(event["data"].as_str().unwrap()).unwrap();
        assert!(bytes.len() <= 4096);
        streams[stream].extend(bytes);
    }
    assert_eq!(attached, 1);
    assert_eq!(streams[0], expected[0]);
    assert_eq!(streams[1], expected[1]);
}
#[test]
fn seventy_thousand_byte_frames_survive_header_and_random_payload_splits() {
    let payload: Vec<u8> = (0..70_000).map(|i| (i % 251) as u8).collect();
    for stream in [1, 2] {
        let frame = mux(stream, &payload);
        let mut offsets: Vec<usize> = (1..=16).collect();
        offsets.extend([
            4095,
            4096,
            8191,
            8192,
            16_383,
            16_384,
            65_535,
            65_536,
            frame.len() - 1,
        ]);
        // Reproducible pseudo-random cuts, independent of every buffer boundary.
        let mut random = 0x2139_u32;
        for _ in 0..32 {
            random = random.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            offsets.push(17 + random as usize % (frame.len() - 17));
        }
        for offset in offsets {
            for framing in ["close", "length", "chunked"] {
                let mut wire = b"HTTP/1.1 200 OK\r\n".to_vec();
                match framing {
                    "length" => write!(wire, "Content-Length: {}\r\n", frame.len()).unwrap(),
                    "chunked" => wire.extend_from_slice(b"Transfer-Encoding: chunked\r\n"),
                    _ => {}
                }
                wire.extend_from_slice(b"\r\n");
                let mut boundaries = Vec::new();
                if framing == "chunked" {
                    for chunk in [&frame[..offset], &frame[offset..]] {
                        write!(wire, "{:x}\r\n", chunk.len()).unwrap();
                        wire.extend_from_slice(chunk);
                        boundaries.push(wire.len());
                        wire.extend_from_slice(b"\r\n");
                    }
                    wire.extend_from_slice(b"0\r\n\r\n");
                } else {
                    boundaries.push(wire.len() + offset);
                    wire.extend_from_slice(&frame);
                }
                let expected = if stream == 1 {
                    [&payload[..], &[][..]]
                } else {
                    [&[][..], &payload[..]]
                };
                assert_payloads(
                    Fragmented {
                        bytes: &wire,
                        boundaries,
                        position: 0,
                        limit: usize::MAX,
                    },
                    expected,
                );
            }
        }
    }
}
#[test]
fn concatenated_large_frames_decode_one_byte_at_a_time_and_in_packed_reads() {
    let stdout = vec![b'o'; 70_000];
    let stderr = vec![b'e'; 70_000];
    let frames = [
        mux(1, &stdout),
        mux(2, &stderr),
        mux(1, b"\nafter\n"),
        mux(2, b"\nafter\n"),
    ]
    .concat();
    let expected = [
        [&stdout[..], b"\nafter\n"].concat(),
        [&stderr[..], b"\nafter\n"].concat(),
    ];
    for chunked in [false, true] {
        let mut wire = b"HTTP/1.1 200 OK\r\n".to_vec();
        if chunked {
            wire.extend_from_slice(b"Transfer-Encoding: chunked\r\n");
        }
        wire.extend_from_slice(b"\r\n");
        if chunked {
            for chunk in frames.chunks(8191) {
                write!(wire, "{:x}\r\n", chunk.len()).unwrap();
                wire.extend_from_slice(chunk);
                wire.extend_from_slice(b"\r\n");
            }
            wire.extend_from_slice(b"0\r\n\r\n");
        } else {
            wire.extend_from_slice(&frames);
        }
        for limit in [1, usize::MAX] {
            assert_payloads(
                Fragmented {
                    bytes: &wire,
                    boundaries: vec![],
                    position: 0,
                    limit,
                },
                [&expected[0], &expected[1]],
            );
        }
    }
}
