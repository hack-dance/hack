use super::*;
use serde_json::{Value, json};

fn input(pending: bool) -> Value {
    json!({
        "version": 1, "kind": "native-persistent-data-owner",
        "binding": {
            "scope": {"namespace": "a".repeat(64), "storage": "db_data", "owner": "b".repeat(32)},
            "guest": {
                "owner": "c".repeat(32), "boot_id": "11111111-2222-3333-4444-555555555555",
                "storage": {"device": 0, "inode": 25, "bytes": 8192, "uuid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}
            },
            "policy": {"driver": "local", "scope": "local", "options": {}}
        },
        "enrollment": if pending {
            json!({"status": "pending", "intent": "d".repeat(32), "volume_name": "hkp-owned-db_data"})
        } else {
            json!({"status": "enrolled", "volume": {
                "name": "hkp-owned-db_data", "created_at": "2026-10-08T12:34:56.123456789Z",
                "directory": {"device": 0, "inode": 91}
            }})
        }
    })
}
fn owner(value: &Value) -> Owner {
    decode(&serde_json::to_vec(value).unwrap()).unwrap()
}
fn observation(value: &Value) -> Observation {
    serde_json::from_value(json!({
        "binding": value["binding"], "volume": value["enrollment"]["volume"]
    }))
    .unwrap()
}
fn matches(record: &Owner, expected: &Binding, observed: Option<&Observation>) -> bool {
    compare(CompareOptions {
        record,
        expected,
        observed,
    })
    .is_ok()
}
fn rejects(value: Value) {
    let error = decode(&serde_json::to_vec(&value).unwrap()).err().unwrap();
    assert_eq!(error.code, "native_persistent_data_identity");
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("private-canary")
    );
}

#[test]
fn independent_runtime_generations_share_only_the_explicit_persistent_binding() {
    let raw = input(false);
    let record = owner(&raw);
    let observed = observation(&raw);
    for run in ["1".repeat(32), "2".repeat(32)] {
        // The caller may have a different run reference; it is neither compared nor encoded.
        let runtime_scope = crate::provider::native_input::Scope {
            namespace: &observed.binding.scope.namespace,
            run: &run,
        };
        let mut expected = observed.binding.clone();
        expected.scope.namespace = runtime_scope.namespace.into();
        assert!(matches(&record, &expected, Some(&observed)));
        let encoded = serde_json::to_string(&record).unwrap();
        assert!(!encoded.contains(runtime_scope.run));
        assert!(!encoded.contains("generation"));
        assert!(!encoded.contains("\"run\""));
        assert!(!encoded.contains("\"plan\""));
    }
    assert_eq!(serde_json::to_value(record).unwrap(), raw);
}

#[test]
fn pending_is_roundtrippable_but_never_enrolled_even_with_exact_observation() {
    let pending = input(true);
    let record = owner(&pending);
    let observed = observation(&input(false));
    assert_eq!(serde_json::to_value(&record).unwrap(), pending);
    assert!(!matches(&record, &observed.binding, Some(&observed)));
    assert!(!matches(&record, &observed.binding, None));
    assert!(!matches(&owner(&input(false)), &observed.binding, None));
    let mut mixed = pending;
    mixed["enrollment"]["volume"] = input(false)["enrollment"]["volume"].clone();
    rejects(mixed);
}

#[test]
fn every_observed_identity_change_refuses_including_copied_labels_new_birth() {
    let raw = input(false);
    let record = owner(&raw);
    let expected = observation(&raw).binding;
    for (pointer, value) in [
        ("/binding/scope/namespace", json!("f".repeat(64))),
        ("/binding/scope/storage", json!("other_data")),
        ("/binding/scope/owner", json!("f".repeat(32))),
        ("/binding/guest/owner", json!("f".repeat(32))),
        (
            "/binding/guest/boot_id",
            json!("ffffffff-2222-3333-4444-555555555555"),
        ),
        ("/binding/guest/storage/device", json!(1)),
        ("/binding/guest/storage/inode", json!(26)),
        ("/binding/guest/storage/bytes", json!(16384)),
        (
            "/binding/guest/storage/uuid",
            json!("ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee"),
        ),
        ("/enrollment/volume/name", json!("hkp-other-db_data")),
        (
            "/enrollment/volume/created_at",
            json!("2026-10-08T12:34:56.123456790Z"),
        ),
        ("/enrollment/volume/directory/device", json!(1)),
        ("/enrollment/volume/directory/inode", json!(92)),
    ] {
        let mut changed = raw.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        let observed = observation(&changed);
        assert!(
            !matches(&record, &expected, Some(&observed)),
            "changed field {pointer}"
        );
        if pointer.starts_with("/binding/") {
            assert!(
                !matches(&record, &observed.binding, Some(&observation(&raw))),
                "expected field {pointer}"
            );
        }
    }
}

#[test]
fn strict_wire_refuses_versions_kinds_missing_null_unknown_fields_and_policy() {
    for (pointer, value) in [
        ("/version", json!(2)),
        ("/version", json!(1.0)),
        ("/kind", json!("cache-provenance")),
        ("/binding/scope/namespace", json!("A".repeat(64))),
        ("/binding/scope/owner", json!("b".repeat(31))),
        ("/binding/scope/storage", json!("../private-canary")),
        (
            "/binding/guest/boot_id",
            json!("00000000-0000-0000-0000-000000000000"),
        ),
        (
            "/binding/guest/boot_id",
            json!("11111111-2222-3333-4444-555555555555\n"),
        ),
        ("/binding/guest/storage/uuid", json!("missing")),
        ("/binding/guest/storage/bytes", json!(0)),
        ("/binding/guest/storage/inode", json!(0)),
        ("/binding/policy/driver", json!("foreign")),
        ("/binding/policy/scope", json!("global")),
        ("/binding/policy/options", json!({"type":"bind"})),
        ("/enrollment/status", json!("adopted")),
        ("/enrollment/volume/name", json!("/private-canary")),
        ("/enrollment/volume/directory/inode", json!(0)),
    ] {
        let mut changed = input(false);
        *changed.pointer_mut(pointer).unwrap() = value;
        rejects(changed);
    }
    for pointer in [
        "",
        "/binding",
        "/binding/scope",
        "/binding/guest",
        "/binding/guest/storage",
        "/binding/policy",
        "/binding/policy/options",
        "/enrollment",
        "/enrollment/volume",
        "/enrollment/volume/directory",
    ] {
        let mut changed = input(false);
        changed
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("private-canary".into(), json!(true));
        rejects(changed);
    }
    for key in ["version", "kind", "binding", "enrollment"] {
        let mut missing = input(false);
        missing.as_object_mut().unwrap().remove(key);
        rejects(missing);
        let mut null = input(false);
        null[key] = Value::Null;
        rejects(null);
    }
    for (parent, key) in [
        ("/binding", "scope"),
        ("/binding", "guest"),
        ("/binding", "policy"),
        ("/binding/scope", "namespace"),
        ("/binding/scope", "storage"),
        ("/binding/scope", "owner"),
        ("/binding/guest", "owner"),
        ("/binding/guest", "boot_id"),
        ("/binding/guest", "storage"),
        ("/binding/guest/storage", "device"),
        ("/binding/guest/storage", "inode"),
        ("/binding/guest/storage", "bytes"),
        ("/binding/guest/storage", "uuid"),
        ("/binding/policy", "driver"),
        ("/binding/policy", "scope"),
        ("/binding/policy", "options"),
        ("/enrollment", "status"),
        ("/enrollment", "volume"),
        ("/enrollment/volume", "name"),
        ("/enrollment/volume", "created_at"),
        ("/enrollment/volume", "directory"),
        ("/enrollment/volume/directory", "device"),
        ("/enrollment/volume/directory", "inode"),
    ] {
        let mut missing = input(false);
        missing
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(key);
        rejects(missing);
        let mut null = input(false);
        null.pointer_mut(parent).unwrap()[key] = Value::Null;
        rejects(null);
    }
    let mut null = input(false);
    null["binding"]["policy"]["options"] = Value::Null;
    rejects(null);
    let mut invalid_pending = input(true);
    invalid_pending["enrollment"]["intent"] = json!("invalid");
    rejects(invalid_pending);
}

#[test]
fn duplicate_fields_and_preallocation_bound_refuse() {
    let raw = serde_json::to_string(&input(false)).unwrap();
    for (needle, duplicate) in [
        ("\"version\":1", "\"version\":1,\"version\":1"),
        (
            "\"status\":\"enrolled\"",
            "\"status\":\"enrolled\",\"status\":\"enrolled\"",
        ),
        (
            "\"storage\":\"db_data\"",
            "\"storage\":\"db_data\",\"storage\":\"db_data\"",
        ),
        ("\"inode\":91", "\"inode\":91,\"inode\":91"),
    ] {
        assert!(raw.contains(needle));
        assert!(decode(raw.replacen(needle, duplicate, 1).as_bytes()).is_err());
    }
    assert!(decode(&[]).is_err());
    assert!(decode(&vec![b' '; LIMIT + 1]).is_err());
    assert!(decode(b"\xff").is_err());
    assert!(decode(format!("{raw} {raw}").as_bytes()).is_err());
}

#[test]
fn malformed_or_unavailable_birth_refuses_without_normalizing_identity() {
    for birth in [
        "",
        "private-canary",
        "0001-01-01T00:00:00Z",
        "0001-01-01T00:00:00.000000000Z",
        "2026-02-29T00:00:00Z",
        "2026-10-08T24:00:00Z",
        "2026-10-08T12:34:56.Z",
        "2026-10-08T12:34:56.1234567890Z",
        "2026-10-08T12:34:56+00:00",
    ] {
        let mut changed = input(false);
        changed["enrollment"]["volume"]["created_at"] = json!(birth);
        rejects(changed);
    }
    let mut changed = input(false);
    changed["enrollment"]["volume"]["created_at"] = Value::Null;
    rejects(changed);
    for birth in ["2000-02-29T00:00:00Z", "2026-10-08T12:34:56.0Z"] {
        let mut changed = input(false);
        changed["enrollment"]["volume"]["created_at"] = json!(birth);
        assert!(decode(&serde_json::to_vec(&changed).unwrap()).is_ok());
    }
}
