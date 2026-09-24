use super::*;
use serde_json::json;

#[cfg(target_os = "macos")]
fn abandoned_publisher() -> (
    super::super::super::tests::Fixture,
    Candidate,
    String,
    String,
    PathBuf,
) {
    let fixture = super::super::super::tests::Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    let run = "a".repeat(32);
    let root = root(&candidate, &run).unwrap();
    let publication = Publication::bind(&candidate, &run).unwrap();
    let mut record: Record = state::read(&root.join("owner.json")).unwrap();
    drop(publication);
    record.process.pid = 2_000_000;
    let bytes = serde_json::to_vec(&record).unwrap();
    fs::write(root.join("owner.json"), &bytes).unwrap();
    let owner = format!("{:x}", Sha256::digest(&bytes));
    (fixture, candidate, run, owner, root)
}

#[cfg(target_os = "macos")]
#[test]
fn recovered_publisher_retirement_is_exact_and_idempotent() {
    let (_fixture, candidate, run, owner, root) = abandoned_publisher();
    let receipt = "f".repeat(64);
    assert!(Retired::acquire(&candidate, &run).unwrap().is_none());
    assert!(verify_recovered_publisher_retired(&candidate, &run, &owner, &receipt).is_err());
    assert!(retire_recovered_publisher(&candidate, &run, &"0".repeat(64), &receipt).is_err());
    retire_recovered_publisher(&candidate, &run, &owner, &receipt).unwrap();
    verify_recovered_publisher_retired(&candidate, &run, &owner, &receipt).unwrap();
    assert!(verify_recovered_publisher_retired(&candidate, &run, &owner, &"e".repeat(64)).is_err());
    assert!(
        root.join("retirement-".to_owned() + &owner + ".json")
            .is_file()
    );
    assert!(retired_path(&root, &owner, true).exists());
    assert!(retired_path(&root, &owner, false).exists());
    let retired = Retired::acquire(&candidate, &run).unwrap().unwrap();
    retired.verify().unwrap();
    drop(retired);
    retire_recovered_publisher(&candidate, &run, &owner, &receipt).unwrap();
    assert!(retire_recovered_publisher(&candidate, &run, &owner, &"e".repeat(64)).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn interrupted_socket_move_resumes_but_replaced_owner_refuses() {
    let (_fixture, candidate, run, owner, root) = abandoned_publisher();
    let receipt = "f".repeat(64);
    let lock = state::Lock::acquire_existing(&root).unwrap();
    let pin = Pin::read(&candidate, &run).unwrap();
    let intent = Retirement {
        version: 1,
        candidate: candidate.checkout.clone(),
        run: run.clone(),
        receipt_sha256: receipt.clone(),
        owner_sha256: owner.clone(),
        parent: pin.record.parent,
        lock: lock.identity().unwrap(),
        socket: pin.record.socket,
        record: pin.record_id,
        owner: pin.record,
    };
    state::write(&retirement_path(&root, &owner), &intent).unwrap();
    fs::rename(root.join("control.sock"), retired_path(&root, &owner, true)).unwrap();
    drop(lock);
    retire_recovered_publisher(&candidate, &run, &owner, &receipt).unwrap();
    assert!(Retired::acquire(&candidate, &run).unwrap().is_some());
    fs::remove_dir_all(root).unwrap();

    let (_fixture, candidate, run, owner, root) = abandoned_publisher();
    let receipt = "f".repeat(64);
    let lock = state::Lock::acquire_existing(&root).unwrap();
    let pin = Pin::read(&candidate, &run).unwrap();
    let intent = Retirement {
        version: 1,
        candidate: candidate.checkout.clone(),
        run: run.clone(),
        receipt_sha256: receipt.clone(),
        owner_sha256: owner.clone(),
        parent: pin.record.parent,
        lock: lock.identity().unwrap(),
        socket: pin.record.socket,
        record: pin.record_id,
        owner: pin.record,
    };
    state::write(&retirement_path(&root, &owner), &intent).unwrap();
    fs::rename(root.join("control.sock"), retired_path(&root, &owner, true)).unwrap();
    fs::remove_file(root.join("owner.json")).unwrap();
    fs::write(root.join("owner.json"), b"foreign").unwrap();
    drop(lock);
    assert!(retire_recovered_publisher(&candidate, &run, &owner, &receipt).is_err());
    assert_eq!(fs::read(root.join("owner.json")).unwrap(), b"foreign");
    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn replaced_socket_or_inherited_listener_refuses_retirement() {
    let (_fixture, candidate, run, owner, root) = abandoned_publisher();
    let socket = root.join("control.sock");
    fs::remove_file(&socket).unwrap();
    let foreign = UnixListener::bind(&socket).unwrap();
    assert!(retire_recovered_publisher(&candidate, &run, &owner, &"f".repeat(64)).is_err());
    assert!(root.join("owner.json").is_file());
    drop(foreign);
    fs::remove_dir_all(root).unwrap();

    let (_fixture, candidate, run, _owner, root) = abandoned_publisher();
    let socket = root.join("control.sock");
    fs::remove_file(&socket).unwrap();
    let inherited = UnixListener::bind(&socket).unwrap();
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
    let mut record: Record = state::read(&root.join("owner.json")).unwrap();
    record.socket = id(&fs::symlink_metadata(&socket).unwrap());
    let bytes = serde_json::to_vec(&record).unwrap();
    fs::write(root.join("owner.json"), &bytes).unwrap();
    let owner = format!("{:x}", Sha256::digest(&bytes));
    assert!(retire_recovered_publisher(&candidate, &run, &owner, &"f".repeat(64)).is_err());
    assert!(socket.exists());
    drop(inherited);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn framed_half_close_keeps_job_client_alive_until_reader_closes() {
    let (mut client, mut server) = UnixStream::pair().unwrap();
    let watch = ClientWatch::new(&server).unwrap();
    write(
        &mut client,
        &json!({"version":1,"run":"owned","remove_data":null}),
        Duration::from_secs(1),
    )
    .unwrap();
    let _: serde_json::Value = read(&mut server, Duration::from_secs(1), REQUEST_LIMIT).unwrap();
    assert!(!watch.disconnected());
    drop(client);
    let deadline = Instant::now() + Duration::from_secs(1);
    while !watch.disconnected() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
}

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
        job: None,
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
