use super::*;
use serde_json::{Value, json};
use std::{
    os::unix::fs::DirBuilderExt,
    sync::atomic::{AtomicU64, Ordering},
};
struct Fixture {
    root: PathBuf,
    candidate: Candidate,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "native-environment-codec-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let candidate = Candidate::discover(&root).unwrap();
        Self { root, candidate }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn intent() -> Value {
    let boot = "12345678-abcd-abcd-abcd-123456789abc";
    json!({"version":2,"kind":"native-environment-allocation","binding":{"namespace":"a".repeat(64),"run":"b".repeat(32),"review":"c".repeat(64),"container":format!("hkn-{}-container-0","b".repeat(32))},"service":"web","uid":0,"gid":0,"slot":format!("hack-env-lease-{boot}-{}","d".repeat(32)),"incarnation":"e".repeat(32),"boot":boot})
}
#[test]
fn native_allocation_codec_has_no_compose_alias_and_refuses_unknown_private_fields() {
    let fixture = Fixture::new();
    let valid = intent();
    let slot = valid["slot"].as_str().unwrap();
    let path = root(&fixture.candidate).join(format!("{slot}.json"));
    state::private_directory(path.parent().unwrap()).unwrap();
    state::write(&path, &valid).unwrap();
    assert_eq!(
        read(&fixture.candidate, slot).unwrap().binding.run,
        "b".repeat(32)
    );
    for (pointer, value) in [
        ("/version", json!(1)),
        ("/kind", json!("environment-allocation")),
        (
            "/binding/container",
            json!(format!("hkg-{}-container-0", "b".repeat(32))),
        ),
        (
            "/binding/container",
            json!(format!("hkn-{}-container-00", "b".repeat(32))),
        ),
        (
            "/binding/container",
            json!(format!("hkn-{}-container-32", "b".repeat(32))),
        ),
        ("/binding/review", json!("short")),
    ] {
        let mut bad = valid.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        state::write(&path, &bad).unwrap();
        assert!(read(&fixture.candidate, slot).is_err());
    }
    let mut bad = valid.clone();
    bad["values"] = json!({"TOKEN":"private-native-canary"});
    state::write(&path, &bad).unwrap();
    let error = read(&fixture.candidate, slot).err().unwrap();
    assert!(!error.message.contains("private-native-canary"));
    state::write(&path, &valid).unwrap();
    state::write(&path.with_extension("pending"), &valid).unwrap();
    assert!(read(&fixture.candidate, slot).is_err());
}
#[test]
fn native_and_compose_history_share_capacity_even_when_compose_history_is_absent() {
    let fixture = Fixture::new();
    let native = root(&fixture.candidate);
    state::private_directory(&native).unwrap();
    for index in 0..4094 {
        fs::write(native.join(format!("{index}.json")), b"uncertain").unwrap();
    }
    assert!(environment_recovery::preflight_records(&fixture.candidate, 2).is_ok());
    assert!(environment_recovery::preflight_records(&fixture.candidate, 3).is_err());
    let compose = fixture.candidate.state_root.join("run/environment-leases");
    state::private_directory(&compose).unwrap();
    fs::write(compose.join("one.json"), b"uncertain").unwrap();
    assert!(environment_recovery::preflight_records(&fixture.candidate, 1).is_ok());
    assert!(environment_recovery::preflight_records(&fixture.candidate, 2).is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn guest_inventory_requires_known_slots_and_exact_selected_absence() {
    let fixture = Fixture::new();
    let native = intent();
    let slot = native["slot"].as_str().unwrap();
    let boot = native["boot"].as_str().unwrap();
    let incarnation = native["incarnation"].as_str().unwrap();
    let path = root(&fixture.candidate).join(format!("{slot}.json"));
    state::private_directory(path.parent().unwrap()).unwrap();
    state::write(&path, &native).unwrap();
    let compose_slot = format!("hack-env-lease-{boot}-{}", "f".repeat(32));
    let compose_path = fixture
        .candidate
        .state_root
        .join("run/environment-leases")
        .join(format!("{compose_slot}.json"));
    state::private_directory(compose_path.parent().unwrap()).unwrap();
    state::write(&compose_path, &json!({"version":1,"service":"sibling","slot":compose_slot,"incarnation":incarnation,"boot":boot})).unwrap();
    let known = known_slots(&fixture.candidate, incarnation, boot).unwrap();
    let output = format!("environment-slot-inventory-v1\n{slot}\n{compose_slot}\n");
    assert!(admit_guest_slots(&output, boot, &known, None).is_ok());
    let selected = Inventory {
        directory: None,
        records: BTreeMap::from([(
            slot.into(),
            RecordWitness {
                identity: (1, 2),
                sha256: "a".repeat(64),
            },
        )]),
    };
    assert!(admit_guest_slots(&output, boot, &known, Some(&selected)).is_err());
    assert!(
        admit_guest_slots(
            &format!("environment-slot-inventory-v1\n{compose_slot}\n"),
            boot,
            &known,
            Some(&selected)
        )
        .is_ok()
    );
    fs::remove_file(&path).unwrap();
    let missing = known_slots(&fixture.candidate, incarnation, boot).unwrap();
    assert!(admit_guest_slots(&output, boot, &missing, None).is_err());
    fs::remove_file(&compose_path).unwrap();
    assert!(
        known_slots(&fixture.candidate, incarnation, boot)
            .unwrap()
            .is_empty()
    );
    assert!(admit_guest_slots(&output, boot, &BTreeSet::new(), None).is_err());
    for output in [
        format!("environment-slot-inventory-v1\n{compose_slot}\n{compose_slot}\n"),
        format!("environment-slot-inventory-v1\n{compose_slot}"),
        "environment-slot-inventory-v1\nunknown-private-canary\n".into(),
    ] {
        assert!(admit_guest_slots(&output, boot, &known, None).is_err());
    }
    let many: BTreeSet<String> = (0..=super::super::environment::MAX_CONCURRENT_ALLOCATIONS)
        .map(|index| format!("hack-env-lease-{boot}-{index:032x}"))
        .collect();
    assert!(
        admit_guest_slots(
            &format!(
                "environment-slot-inventory-v1\n{}\n",
                many.iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
            boot,
            &many,
            None
        )
        .is_err()
    );
    assert!(
        admit_guest_slots(
            &format!("environment-slot-inventory-v1\n{compose_slot}\n"),
            "22345678-abcd-abcd-abcd-123456789abc",
            &known,
            None
        )
        .is_err()
    );
    // A retained pending record cannot become completeness evidence or be promoted.
    state::write(&compose_path.with_extension("pending"), &json!({"version":1,"service":"sibling","slot":compose_slot,"incarnation":incarnation,"boot":boot})).unwrap();
    assert!(known_slots(&fixture.candidate, incarnation, boot).is_err());
    assert!(!compose_path.exists());
}
