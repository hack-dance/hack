use super::*;
use serde_json::json;

#[test]
fn legacy_requests_and_private_schema_are_strict() {
    let request: WireRequest =
        serde_json::from_str(r#"{"version":1,"run":"run","remove_data":false}"#).unwrap();
    assert!(request.restore.is_none());
    assert!(
        serde_json::to_value(request)
            .unwrap()
            .get("restore")
            .is_none()
    );
    for text in [
        r#"{"plan":"p","generation":"g","environment":"first","environment":"second"}"#,
        r#"{"plan":"p","generation":"g","environment":null}"#,
        r#"{"plan":"p","generation":"g","environment":""}"#,
        r#"{"plan":"p","generation":"g","environment":"value","extra":1}"#,
        r#"{"plan":"p","generation":"g","environment":"unterminated}"#,
    ] {
        assert!(serde_json::from_str::<RestoreRequest>(text).is_err());
    }
    assert!(PrivateText::from_bytes(&[255]).is_err());
    assert!(PrivateText::from_bytes(b"").is_err());
    assert!(PrivateText::from_bytes(&vec![b'x'; PRIVATE_LIMIT + 1]).is_err());
    let oversized = json!({"plan":"p","generation":"g","environment":"x".repeat(PRIVATE_LIMIT+1)});
    assert!(serde_json::from_value::<RestoreRequest>(oversized).is_err());
}

#[test]
fn maximum_private_text_roundtrips_with_bounded_escaped_frame() {
    let private = "\\".repeat(PRIVATE_LIMIT);
    let request = WireRequest {
        version: 1,
        run: "a".repeat(32),
        remove_data: None,
        restore: Some(RestoreRequest {
            plan: "b".repeat(64),
            generation: "c".repeat(32),
            environment: PrivateText::from_bytes(private.as_bytes()).unwrap(),
        }),
    };
    let (mut writer, mut reader) = UnixStream::pair().unwrap();
    let child = std::thread::spawn(move || {
        write(&mut writer, &request, Duration::from_secs(5)).unwrap();
    });
    let received: WireRequest = read(&mut reader, Duration::from_secs(5), REQUEST_LIMIT).unwrap();
    child.join().unwrap();
    assert_eq!(
        received.restore.unwrap().environment.as_bytes(),
        private.as_bytes()
    );
}

#[test]
fn framing_refuses_zero_oversize_truncation_and_trailing_bytes() {
    for frame in [
        0u32.to_be_bytes().to_vec(),
        ((REQUEST_LIMIT + 1) as u32).to_be_bytes().to_vec(),
        vec![0, 0, 0, 2, b'{'],
        vec![0, 0, 0, 2, b'{', b'}', b'x'],
    ] {
        let (mut writer, mut reader) = UnixStream::pair().unwrap();
        writer.write_all(&frame).unwrap();
        writer.shutdown(Shutdown::Write).unwrap();
        assert!(
            read::<serde_json::Value>(&mut reader, Duration::from_secs(1), REQUEST_LIMIT).is_err()
        );
    }
}

#[test]
fn oversized_serialization_fails_before_sending_any_frame() {
    let (mut writer, mut reader) = UnixStream::pair().unwrap();
    writer
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    reader
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    assert!(
        write(
            &mut writer,
            &"x".repeat(REQUEST_LIMIT + 1),
            Duration::from_secs(1)
        )
        .is_err()
    );
    drop(writer);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).unwrap();
    assert!(bytes.is_empty());
}
