use super::*;
use serde_json::json;

#[test]
fn publication_refuses_a_replaced_operation_lock_and_preserves_it() {
    let fixture = super::super::super::tests::Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    let run = "a".repeat(32);
    let publication = Publication::bind(&candidate, &run).unwrap();
    publication.verify().unwrap();
    let directory = root(&candidate, &run).unwrap();
    fs::rename(
        directory.join("operation.lock"),
        directory.join("original.lock"),
    )
    .unwrap();
    let replacement = state::Lock::acquire(&directory).unwrap();
    let replaced = fs::read(directory.join("operation.lock")).unwrap();
    assert!(publication.verify().is_err());
    assert_eq!(
        fs::read(directory.join("operation.lock")).unwrap(),
        replaced
    );
    assert!(directory.join("original.lock").exists());
    drop(replacement);
}

#[test]
fn pool_gate_excludes_publication_before_engine_for_every_run() {
    let fixture = super::super::super::tests::Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    let gate = super::super::super::publication_gate::Guard::acquire(&candidate).unwrap();
    for run in ["a".repeat(32), "b".repeat(32)] {
        assert!(Publication::bind(&candidate, &run).is_err());
        assert!(!root(&candidate, &run).unwrap().exists());
    }
    gate.verify(&candidate).unwrap();
    drop(gate);
    let mut first = Publication::bind(&candidate, &"a".repeat(32)).unwrap();
    // A publisher keeps its own run lock, not the pool gate for its lifetime.
    let mut second = Publication::bind(&candidate, &"b".repeat(32)).unwrap();
    first.finish().unwrap();
    second.finish().unwrap();
    for run in ["a".repeat(32), "b".repeat(32)] {
        fs::remove_dir_all(root(&candidate, &run).unwrap()).unwrap();
    }
}

#[test]
fn pool_gate_refuses_a_replaced_lock_path() {
    let fixture = super::super::super::tests::Fixture::new();
    let candidate = Candidate::discover(&fixture.0).unwrap();
    let gate = super::super::super::publication_gate::Guard::acquire(&candidate).unwrap();
    let directory = candidate.state_root.join("run/graph-publication-gate");
    fs::rename(
        directory.join("operation.lock"),
        directory.join("original.lock"),
    )
    .unwrap();
    let _replacement = state::Lock::acquire(&directory).unwrap();
    assert!(gate.verify(&candidate).is_err());
    assert!(directory.join("original.lock").exists());
}

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
    for _ in 0..2 {
        retired
            .verify_recovery(&candidate, &run, &owner, &receipt)
            .unwrap();
    }
    for (selected_owner, selected_receipt) in [
        ("0".repeat(64), receipt.clone()),
        (owner.clone(), "e".repeat(64)),
        ("invalid".into(), receipt.clone()),
        (owner.clone(), "invalid".into()),
    ] {
        assert!(
            retired
                .verify_recovery(&candidate, &run, &selected_owner, &selected_receipt)
                .is_err()
        );
    }
    assert!(
        retired
            .verify_recovery(&candidate, &"b".repeat(32), &owner, &receipt)
            .is_err()
    );
    drop(retired);
    retire_recovered_publisher(&candidate, &run, &owner, &receipt).unwrap();
    assert!(retire_recovered_publisher(&candidate, &run, &owner, &"e".repeat(64)).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn cleanup_fence_refuses_effects_and_resumes_each_retirement_rename() {
    for fail_at in [1, 3, 4, 5, 6] {
        let (_fixture, candidate, run, owner, directory) = abandoned_publisher();
        let receipt = "f".repeat(64);
        let before = fs::read(directory.join("owner.json")).unwrap();
        let sibling_run = "b".repeat(32);
        let mut sibling = Publication::bind(&candidate, &sibling_run).unwrap();
        let sibling_root = root(&candidate, &sibling_run).unwrap();
        let sibling_before = fs::read(sibling_root.join("owner.json")).unwrap();
        let lock = state::Lock::acquire_existing(&directory).unwrap();
        let calls = std::cell::Cell::new(0);
        let fence = || {
            calls.set(calls.get() + 1);
            if calls.get() == fail_at {
                Err(retirement_refused())
            } else {
                Ok(())
            }
        };
        assert!(
            retire_recovered_publisher_locked_fenced(
                &candidate, &run, &owner, &receipt, None, &lock, &fence,
            )
            .is_err()
        );
        assert_eq!(calls.get(), fail_at);
        let owner_path = if fail_at == 6 {
            retired_path(&directory, &owner, false)
        } else {
            directory.join("owner.json")
        };
        assert_eq!(fs::read(&owner_path).unwrap(), before);
        let expected_process = serde_json::from_slice::<Record>(&before).unwrap().process;
        assert_eq!(
            selected_retirement_process(&candidate, &run, &owner, &receipt, &lock).unwrap(),
            expected_process,
        );
        assert!(
            selected_retirement_process(&candidate, &run, &"e".repeat(64), &receipt, &lock)
                .is_err()
        );
        let journal = retirement_path(&directory, &owner);
        assert_eq!(journal.exists(), fail_at >= 4);
        assert_eq!(directory.join("control.sock").exists(), fail_at < 5);
        assert_eq!(
            retired_path(&directory, &owner, true).exists(),
            fail_at >= 5
        );
        if journal.exists() {
            let retained = fs::read(&journal).unwrap();
            assert!(
                retire_recovered_publisher_locked_fenced(
                    &candidate,
                    &run,
                    &owner,
                    &"e".repeat(64),
                    None,
                    &lock,
                    &|| Ok(()),
                )
                .is_err()
            );
            assert_eq!(fs::read(&journal).unwrap(), retained);
            assert_eq!(fs::read(&owner_path).unwrap(), before);
        }
        retire_recovered_publisher_locked_fenced(
            &candidate,
            &run,
            &owner,
            &receipt,
            None,
            &lock,
            &|| Ok(()),
        )
        .unwrap();
        assert!(!directory.join("control.sock").exists());
        assert!(!directory.join("owner.json").exists());
        assert_eq!(
            selected_retirement_process(&candidate, &run, &owner, &receipt, &lock).unwrap(),
            expected_process,
        );
        assert_eq!(
            fs::read(retired_path(&directory, &owner, false)).unwrap(),
            before
        );
        let archived_owner = fs::symlink_metadata(retired_path(&directory, &owner, false)).unwrap();
        let archived_socket = fs::symlink_metadata(retired_path(&directory, &owner, true)).unwrap();
        let journal_bytes = fs::read(&journal).unwrap();
        retire_recovered_publisher_locked_fenced(
            &candidate,
            &run,
            &owner,
            &receipt,
            None,
            &lock,
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!(fs::read(&journal).unwrap(), journal_bytes);
        assert_eq!(
            id(&fs::symlink_metadata(retired_path(&directory, &owner, false)).unwrap()),
            id(&archived_owner)
        );
        assert_eq!(
            id(&fs::symlink_metadata(retired_path(&directory, &owner, true)).unwrap()),
            id(&archived_socket)
        );
        assert_eq!(
            fs::read(sibling_root.join("owner.json")).unwrap(),
            sibling_before
        );
        sibling.verify().unwrap();
        sibling.finish().unwrap();
        fs::remove_dir_all(sibling_root).unwrap();
        drop(lock);
        fs::remove_dir_all(directory).unwrap();
    }
}

#[cfg(target_os = "macos")]
#[test]
fn retired_recovery_refuses_pending_missing_and_partial_proof_without_mutation() {
    let (_fixture, candidate, run, owner, root) = abandoned_publisher();
    let receipt = "f".repeat(64);
    retire_recovered_publisher(&candidate, &run, &owner, &receipt).unwrap();
    let retired = Retired::acquire(&candidate, &run).unwrap().unwrap();
    let verify = || retired.verify_recovery(&candidate, &run, &owner, &receipt);
    let path = retirement_path(&root, &owner);
    let bytes = fs::read(&path).unwrap();
    let pending = path.with_extension("pending");
    fs::write(&pending, b"interrupted retirement").unwrap();
    assert!(verify().is_err());
    assert_eq!(fs::read(&pending).unwrap(), b"interrupted retirement");
    assert_eq!(fs::read(&path).unwrap(), bytes);
    fs::remove_file(pending).unwrap();

    let retained = root.join("saved-retirement.json");
    fs::rename(&path, &retained).unwrap();
    assert!(verify().is_err(), "pathname absence cannot replace proof");
    assert_eq!(fs::read(&retained).unwrap(), bytes);
    fs::rename(&retained, &path).unwrap();

    let record = retired_path(&root, &owner, false);
    fs::rename(&record, root.join("owner.json")).unwrap();
    assert!(
        verify().is_err(),
        "partial retirement must not be completed"
    );
    assert!(root.join("owner.json").is_file());
    assert!(!record.exists());
    fs::rename(root.join("owner.json"), &record).unwrap();
    verify().unwrap();
    drop(retired);
    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn retired_recovery_rechecks_archived_record_socket_and_lock_identity() {
    for changed in ["record", "socket", "lock"] {
        let (_fixture, candidate, run, owner, root) = abandoned_publisher();
        let receipt = "f".repeat(64);
        retire_recovered_publisher(&candidate, &run, &owner, &receipt).unwrap();
        let retired = Retired::acquire(&candidate, &run).unwrap().unwrap();
        retired
            .verify_recovery(&candidate, &run, &owner, &receipt)
            .unwrap();
        let path = match changed {
            "record" => retired_path(&root, &owner, false),
            "socket" => retired_path(&root, &owner, true),
            "lock" => root.join("operation.lock"),
            _ => unreachable!(),
        };
        let saved = root.join("saved-evidence");
        fs::rename(&path, &saved).unwrap();
        let listener = if changed == "socket" {
            Some(UnixListener::bind(&path).unwrap())
        } else {
            let bytes = fs::read(&saved).unwrap();
            fs::write(&path, bytes).unwrap();
            None
        };
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let replacement = id(&fs::symlink_metadata(&path).unwrap());
        assert!(
            retired
                .verify_recovery(&candidate, &run, &owner, &receipt)
                .is_err(),
            "{changed}"
        );
        assert_eq!(id(&fs::symlink_metadata(&path).unwrap()), replacement);
        assert!(saved.exists());
        drop(listener);
        drop(retired);
        fs::remove_dir_all(root).unwrap();
    }
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
fn selected_legacy_device_socket_move_resumes_only_exact_retirement() {
    let (_fixture, candidate, run, _original_owner, root) = abandoned_publisher();
    let receipt = "f".repeat(64);
    let current = id(&fs::symlink_metadata(&root).unwrap()).0;
    let rebind = DeviceRebind {
        old: current.checked_add(1).unwrap(),
        current,
    };
    let mut record: Record = state::read(&root.join("owner.json")).unwrap();
    assert_eq!(record.parent.0, current);
    assert_eq!(record.socket.0, current);
    record.parent.0 = rebind.old;
    record.socket.0 = rebind.old;
    let bytes = serde_json::to_vec(&record).unwrap();
    fs::write(root.join("owner.json"), &bytes).unwrap();
    let owner = format!("{:x}", Sha256::digest(&bytes));
    assert!(Pin::read(&candidate, &run).is_err());
    let lock = state::Lock::acquire_existing(&root).unwrap();
    let pin = Pin::read_with_rebind(&candidate, &run, Some(rebind)).unwrap();
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
    assert!(retire_recovered_publisher(&candidate, &run, &owner, &receipt).is_err());
    retire_recovered_publisher_recovery(&candidate, &run, &owner, &receipt, Some(rebind)).unwrap();
    let retired = Retired::acquire(&candidate, &run).unwrap().unwrap();
    retired
        .verify_recovery_with_rebind(&candidate, &run, &owner, &receipt, Some(rebind))
        .unwrap();
    assert!(
        retired
            .verify_recovery(&candidate, &run, &owner, &receipt)
            .is_err()
    );
    drop(retired);
    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn dead_owner_guard_refuses_replaced_foreground_lock_path() {
    let (_fixture, candidate, run, _owner, root) = abandoned_publisher();
    let dead = DeadOwner::acquire(&candidate, &run).unwrap();
    dead.verify().unwrap();
    let pathname = root.join("operation.lock");
    let saved = root.join("held-operation.lock");
    fs::rename(&pathname, &saved).unwrap();
    fs::write(&pathname, b"replacement").unwrap();
    fs::set_permissions(&pathname, fs::Permissions::from_mode(0o600)).unwrap();
    let replacement = id(&fs::symlink_metadata(&pathname).unwrap());
    assert!(dead.verify().is_err());
    assert_eq!(id(&fs::symlink_metadata(&pathname).unwrap()), replacement);
    assert_eq!(fs::read(&pathname).unwrap(), b"replacement");
    drop(dead);
    fs::remove_file(&pathname).unwrap();
    fs::rename(&saved, &pathname).unwrap();
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
        refresh_dependencies: None,
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
fn dependency_refresh_is_an_exclusive_strict_metadata_request() {
    let mut value = json!({"version":1,"run":"a".repeat(32),"remove_data":null,
        "refresh_dependencies":{"plan":"b".repeat(64),"generation":"c".repeat(64),"boot":"boot"}});
    let request: WireRequest = serde_json::from_value(value.clone()).unwrap();
    assert!(request.exclusive());
    value["remove_data"] = json!(false);
    let request: WireRequest = serde_json::from_value(value.clone()).unwrap();
    assert!(!request.exclusive());
    value["remove_data"] = serde_json::Value::Null;
    value["refresh_dependencies"]["host_port"] = json!(8443);
    assert!(serde_json::from_value::<WireRequest>(value).is_err());
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
